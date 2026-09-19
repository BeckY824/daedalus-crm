#!/usr/bin/env node
/**
 * 把 CRM 本体装配成一份能随桌面端一起发布的「本地服务」。
 *
 * 产物是 desktop/server-bundle/，里面是一套自带 node_modules 的 Next standalone
 * 服务、Prisma 引擎、建表 SQL、增量迁移，以及一个**已经建好账号的模板库**。
 * 桌面端启动时用 Electron 自带的 Node 直接跑它，所以用户机器上不需要装任何东西。
 *
 * 为什么模板库在这里生成而不是首次启动时现建：
 * 首次启动要建表 + 写三个账号，写账号得用 Prisma（密码要 bcrypt、id 要 cuid）。
 * 让打包好的 seed 脚本在用户机器上跑起来，就要处理 Prisma 引擎的路径解析——
 * 那是 Electron 里最容易碎的一环。改成构建期把库建好、运行期只复制一个文件，
 * 这条路上就没有任何会碎的东西了。账号密码在首次启动时改成随机值，见 server-entry.js。
 *
 * 用法：
 *   node scripts/build-server.mjs            # 完整装配（含 next build）
 *   node scripts/build-server.mjs --no-build # 复用上一次的 .next，只重新装配
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.resolve(DESKTOP, "..");
const OUT = path.join(DESKTOP, "server-bundle");
const 跳过构建 = process.argv.includes("--no-build");

/** 构建期占位值。它们不会进产物：运行时由 Electron 注入真实值 */
const 构建期环境 = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: "1",
  DATABASE_URL: "file:/tmp/desktop-build.db",
  CONTROL_DATABASE_URL: "file:/tmp/desktop-build-control.db",
  // next build 跑的是 NODE_ENV=production，而 auth.ts 在模块顶层就校验密钥长度，
  // 不给的话所有引了 requireUser 的页面都会在收集页面数据时失败。理由同 Dockerfile。
  AUTH_SECRET: "build-time-placeholder-never-used-at-runtime-0123456789",
};

function 跑(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: APP, env: 构建期环境, stdio: "inherit", ...opts });
}

function 步骤(n, 说明) {
  console.log(`\n[${n}/9] ${说明}`);
}

/* ---------- 1. Prisma 客户端 ---------- */
步骤(1, "生成 Prisma 客户端");
// 控制面客户端在本地模式下一次都不会被调用，但 tenant/ 下的模块在 import 层面引了它，
// 不生成的话应用一启动就是 MODULE_NOT_FOUND
跑("npx", ["prisma", "generate"]);
跑("npx", ["prisma", "generate", "--schema=prisma/control.prisma"]);

/* ---------- 2. 构建 ---------- */
if (跳过构建) {
  console.log("\n[2/9] 跳过 next build（--no-build）");
  if (!fs.existsSync(path.join(APP, ".next/standalone"))) {
    console.error("  !! 没有现成的 .next/standalone，去掉 --no-build 重跑");
    process.exit(1);
  }
} else {
  步骤(2, "构建 Next（standalone）");
  跑("npx", ["next", "build"]);
}

/* ---------- 3. 建表 SQL ---------- */
步骤(3, "导出建表 SQL");
const schemaSql = execFileSync(
  "npx",
  ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/schema.prisma", "--script"],
  { cwd: APP, env: 构建期环境, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
const 临时 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-desktop-"));
const schemaSqlFile = path.join(临时, "schema.sql");
fs.writeFileSync(schemaSqlFile, schemaSql);

/* ---------- 4. 模板库（建表 + 迁移 + 三个账号）---------- */
步骤(4, "生成模板库（含初始账号）");
const 模板库 = path.join(临时, "template.db");
跑("node", ["--experimental-sqlite", "scripts/build-template.mjs", 模板库, schemaSqlFile]);
/**
 * 账号写进模板库。这里的密码只是占位：首次启动时会被改成每台机器各不相同的随机值，
 * 否则所有安装包共用一个密码，哪天有人把这个库搬到服务器上就是一把公开的钥匙。
 */
跑("npx", ["tsx", "prisma/seed.ts"], {
  env: { ...构建期环境, DATABASE_URL: `file:${模板库}`, INIT_PASSWORD: "placeholder-replaced-on-first-run", QUIET_PASSWORD: "1" },
});
/**
 * 收个尾再发布。写过的库可能还带着 -wal / -shm，只拷 .db 就会丢掉最后那几笔写入——
 * 表现是装出来的应用一打开「一个账号都没有」。VACUUM INTO 直接产出一个自洽的单文件。
 */
const 干净模板 = path.join(临时, "template-clean.db");
跑("node", ["--experimental-sqlite", "-e", `
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.argv[1]);
  db.exec("VACUUM INTO '" + process.argv[2] + "'");
  const n = db.prepare('SELECT COUNT(*) AS n FROM User').get().n;
  db.close();
  if (!n) { console.error('模板库里一个账号都没有'); process.exit(1); }
  console.log('  模板库账号数：' + n);
`, 模板库, 干净模板]);

/* ---------- 5. 装配 ---------- */
步骤(5, "装配 server-bundle");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const 拷 = (从, 到) => {
  const src = path.join(APP, 从);
  if (!fs.existsSync(src)) throw new Error(`缺少 ${从}`);
  fs.cpSync(src, path.join(OUT, 到), { recursive: true, dereference: true });
  console.log(`  + ${到}`);
};

/**
 * 只取真正要跑的那几样。
 *
 * Next 的 standalone 并不像文档说的那样只有必要文件：它把整个项目目录又拷了一份进去，
 * docs、e2e、test-results 都在，连 desktop/node_modules（里面躺着 500M 的 Electron）
 * 也一起拷。整个拿过来是 750M，挑出来只有 60M 上下。
 */
拷(".next/standalone/server.js", "server.js");
拷(".next/standalone/package.json", "package.json");
拷(".next/standalone/node_modules", "node_modules");
拷(".next/standalone/.next", ".next");
// Prisma 客户端与引擎生成在 src/generated 下，是运行时真要加载的
拷(".next/standalone/src/generated", "src/generated");
拷(".next/static", ".next/static");
拷("public", "public");
/**
 * Next 的依赖追踪会漏掉 Prisma（客户端是 generate 出来的，不是静态引用），
 * 不显式拷贝的话应用一查库就 MODULE_NOT_FOUND。和 Dockerfile 里同一处理。
 */
拷("node_modules/@prisma/client", "node_modules/@prisma/client");
拷("node_modules/.prisma", "node_modules/.prisma");
// bcryptjs 被 Next 打进了 server chunk，包里没有单独的模块，
// 而首次启动要用它把账号密码改成本机随机值（entry.js）。它是纯 JS，带一份不费事
拷("node_modules/bcryptjs", "node_modules/bcryptjs");
// 首次启动复制它；之后每次启动按序重跑 migrations（内容幂等）
fs.copyFileSync(干净模板, path.join(OUT, "template.db"));
console.log("  + template.db");
拷("migrations", "migrations");
fs.copyFileSync(path.join(DESKTOP, "server-entry.js"), path.join(OUT, "entry.js"));
console.log("  + entry.js");
fs.rmSync(临时, { recursive: true, force: true });

/* ---------- 6. 裁掉别的平台的 Prisma 引擎 ---------- */
步骤(6, "裁掉非本平台的 Prisma 引擎");
const 本平台引擎 =
  process.platform === "win32"
    ? "libquery_engine-windows.dll.node"
    : process.platform === "darwin"
      ? process.arch === "arm64"
        ? "libquery_engine-darwin-arm64.dylib.node"
        : "libquery_engine-darwin.dylib.node"
      : null; // Linux 下不裁：本地桌面端不发 Linux 包，留着方便本机调试

let 留下 = 0;
let 删掉 = 0;
function 走一遍(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      走一遍(p);
    } else if (e.name.startsWith("libquery_engine-")) {
      if (本平台引擎 && e.name !== 本平台引擎) {
        fs.rmSync(p);
        删掉++;
      } else {
        留下++;
        console.log(`  留下 ${path.relative(OUT, p)}`);
      }
    }
  }
}
走一遍(OUT);
if (本平台引擎 && 留下 === 0) {
  console.error(`  !! 产物里没有本平台的 Prisma 引擎（${本平台引擎}），装出来的应用一查库就会崩`);
  process.exit(1);
}
console.log(`  删掉 ${删掉} 个其它平台的引擎`);

/* ---------- 7. 裁掉别家数据库的 wasm 引擎 ---------- */
/*
  `@prisma/client/runtime` 里躺着五套数据库各自的 wasm 引擎，每套还分 .js / .mjs 两份：

    query_engine_bg.{sqlite,postgresql,mysql,sqlserver,cockroachdb}.wasm-base64.{js,mjs}
    query_compiler_bg.{同上}.wasm-base64.{js,mjs}

  合计 **53 MB**，占整个桌面包的三分之一，而我们只用 SQLite，而且**走的是原生
  libquery_engine-*.dylib.node，根本不走 wasm**。

  为什么敢删：把整个 @prisma/client 翻了一遍，**运行时的 .js / .mjs 没有一个文件
  提到 `wasm-base64`**，唯一提到它的是 `generator-build/index.js`——那是
  `prisma generate` 时跑的代码生成器，它读这些大块、吐出各自库下面那个 query_engine_bg.wasm（注意别在块注释里写星号加斜杠，那会把注释提前闭掉）。
  生成早在构建机上做完了，装到用户机器上的应用永远不会再跑一次生成器。
  （文件里确实出现「cockroachdb」这类词，但那是校验用的字符串常量，不是文件名。）

  **删不到东西要吭声。** Prisma 换个布局、改个命名，这一步就会静悄悄变成空转，
  而包又胖回去 53 MB，没人会发现——和第 6 步那条「一个引擎都没留下就 exit 1」同一个道理。
*/
步骤(7, "裁掉别家数据库的 wasm 引擎");
let 省了 = 0;
let 删了几个 = 0;
function 裁wasm(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      裁wasm(p);
    } else if (/^query_(engine|compiler)_bg\..+\.wasm-base64\.(js|mjs)$/.test(e.name)) {
      省了 += fs.statSync(p).size;
      fs.rmSync(p);
      删了几个++;
    }
  }
}
裁wasm(OUT);
if (删了几个 === 0) {
  console.error("  !! 一个 wasm-base64 都没删到。多半是 Prisma 换了文件布局——");
  console.error("     去 node_modules/@prisma/client/runtime 看一眼实际文件名，把上面那条正则改对。");
  console.error("     不改的话包会白胖 50 MB 以上，而且没有任何报错。");
  process.exit(1);
}
console.log(`  删掉 ${删了几个} 个，省下 ${(省了 / 1024 / 1024).toFixed(0)} MB`);

/* ---------- 8. 裁掉控制面库的查询引擎 ---------- */
/*
  控制面库（账号、工作区、成员、AI 额度）只有托管版才有。本地桌面端是单租户：
  local-server.js 把 MULTI_TENANT 明确置空，也从不给 CONTROL_DATABASE_URL；
  而每一处用到 `control` 的地方——billing、admin、api/feedback、api/public/stats、
  shared-ws/current——都先判 multiTenant() 再碰它。桌面端一次都走不到那行。

  **但客户端本体必须留着。** `next build` 要靠它解析 @/generated/control；
  而且 Next 现在是把整份 Prisma 客户端内联进 .next/server/chunks 的，
  哪天它改回「当外部依赖」，目录不在就是启动即 MODULE_NOT_FOUND——应用直接打不开。
  所以只删两个大文件，它们**只在真的去连控制面库那一刻（$connect）才加载**：

    src/generated/control/libquery_engine-<平台>.node   18 MB
    src/generated/control/query_engine_bg.wasm          2.1 MB

  整个目录删掉能再省 1 MB 出头，不值这个险——理由同上。
*/
步骤(8, "裁掉控制面库的查询引擎");
const 控制面 = path.join(OUT, "src/generated/control");
if (!fs.existsSync(控制面)) {
  console.error("  !! 产物里没有 src/generated/control，第 5 步的拷贝清单是不是改了");
  process.exit(1);
}
let 控省 = 0;
let 控删 = 0;
for (const e of fs.readdirSync(控制面, { withFileTypes: true })) {
  if (!e.isFile()) continue;
  if (!e.name.startsWith("libquery_engine-") && e.name !== "query_engine_bg.wasm") continue;
  const p = path.join(控制面, e.name);
  控省 += fs.statSync(p).size;
  fs.rmSync(p);
  控删++;
  console.log(`  删掉 src/generated/control/${e.name}`);
}
/** 删不到东西要吭声，理由同第 7 步：静悄悄空转，包胖回去 20 MB 没人发现 */
if (控删 === 0) {
  console.error("  !! 控制面客户端里一个查询引擎都没删到。多半是 Prisma 换了引擎的文件名——");
  console.error("     去 src/generated/control 看一眼实际文件名，把上面的判断改对。");
  console.error("     不改的话包会白胖 20 MB 以上，而且没有任何报错。");
  process.exit(1);
}
/** 删过头的下场是「装上打不开」，本机 npm run dev 完全看不出来 */
if (!fs.existsSync(path.join(控制面, "index.js"))) {
  console.error("  !! 连控制面客户端本体都删掉了（缺 index.js），这个包装上打不开");
  process.exit(1);
}
console.log(`  删掉 ${控删} 个，省下 ${(控省 / 1024 / 1024).toFixed(0)} MB`);

/* ---------- 9. 业务库的原生引擎必须还在 ---------- */
/*
  上面三步都在删文件，而删错了的下场是「装上打开就崩」，本机 `npm run dev`
  完全看不出来（那条路不走这个产物）。所以最后再核一次：业务库的原生引擎在不在。
  这是 0.37.0 那次事故（白名单漏了 mcp-bridge.js，应用整个打不开）留下的规矩——
  凡是「删了/漏了只在用户机器上才炸」的事，构建脚本里必须有一条断言。

  这里盯死 src/generated/prisma 这一份，不是「全包里随便哪儿有一份就算数」：
  第 8 步起，包里本来就存心少了一份引擎（控制面那份），
  「哪儿都行」的判断会被别处的副本蒙混过去，而业务库那份才是每一次查询都要加载的。
*/
步骤(9, "核对业务库的原生引擎还在");
if (本平台引擎) {
  const 业务引擎 = path.join(OUT, "src/generated/prisma", 本平台引擎);
  if (!fs.existsSync(业务引擎)) {
    console.error(`  !! src/generated/prisma/${本平台引擎} 不见了，这个包装上一查库就崩`);
    process.exit(1);
  }
  console.log(`  ✓ ${path.relative(OUT, 业务引擎)}`);
}

const 大小 = execFileSync("du", ["-sh", OUT], { encoding: "utf8" }).split("\t")[0];
console.log(`\n装配完成：${OUT}（${大小}）`);
