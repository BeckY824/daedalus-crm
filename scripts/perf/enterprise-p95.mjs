#!/usr/bin/env node
/**
 * 企业版压测（10-24 结果：30 人 × 10 倍数据，主要页面 p95 < 200 ms）。
 *
 *   node scripts/perf/enterprise-p95.mjs --out <输出目录> [--scale 10] [--duration 180] [--port 3570] [--skip-build] [--reuse-db] [--extra]
 *   GATE=1 …   任何一页 p95 ≥ 200 ms 或有请求出错就以 1 退出
 *
 * 流程：
 *   1. <输出目录>/crm.db 新建一份空库（prisma db push），enterprise-seed.ts 造 30 人 + SCALE 倍数据；
 *      --extra 再加一组逾期跟进计划和带节点的订单（见 enterprise-seed.ts，2026-10-25 起），不加就和原来一样、旧基线能比。
 *      --reuse-db 时库里是哪种数据看 <输出目录>/seed.json（没有就是不加的那种），和这次要的对不上就报错
 *   2. next build + next start，按企业版部署包的样子起：CRM_ENTERPRISE=1，不设 DESKTOP_DATA / MULTI_TENANT，TZ=Asia/Shanghai
 *   3. 用同一个 AUTH_SECRET 给 30 个人各签一张会话票据（和 createSession 一样的 HS256 + {sub, ims}），不走登录、不碰密码
 *   4. 单人基线：一个销售按顺序把每页开 15 次（前 3 次热身不算）
 *   5. 压测：30 人同时用，每人打开一页、停 1–3 秒再开下一页，持续 --duration 秒；
 *      每次随机挑一页，一半整页打开（HTML），一半站内切页（RSC，带 RSC: 1 头）
 *   6. 各页 × 两种打开方式的 p50 / p95 / p99、出错数、服务端内存，写进 result.json 和 result.md
 *
 * 耗时口径：从发请求到响应体读完（服务端渲染 + 传输），本机回环，不含浏览器解析和水合。
 * 只用 <输出目录> 里新建的库，不碰正式库、不花钱（LLM_API_KEY 置空）。
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const 仓库 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(仓库, "package.json"));
const { SignJWT } = require("jose");

const 参数 = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] === undefined ? "1" : arr[i + 1]]] : a), []));
if (!参数.out) throw new Error("要 --out <输出目录>");
const 输出 = path.resolve(参数.out);
const SCALE = Number(参数.scale ?? 10);
const 时长 = Number(参数.duration ?? 180) * 1000;
const 端口 = Number(参数.port ?? 3570);
const 站 = `http://127.0.0.1:${端口}`;
const 库 = path.join(输出, "crm.db");
const 名单文件 = path.join(输出, "people.json");
const 种子文件 = path.join(输出, "seed.json");
const 加一组 = 参数.extra === "1";
const 密钥 = "perf-only-secret-not-used-anywhere-else-0123456789";
const 门槛 = 200;
const 等 = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(输出, { recursive: true });

const 环境 = {
  ...process.env,
  NODE_ENV: "production",
  DATABASE_URL: `file:${库}`,
  AUTH_SECRET: 密钥,
  CRM_ENTERPRISE: "1",
  COOKIE_SECURE: "false",
  TZ: "Asia/Shanghai",
  LLM_API_KEY: "",
  NEXT_TELEMETRY_DISABLED: "1",
};
delete 环境.DESKTOP_DATA;
delete 环境.DESKTOP_LOCAL;
delete 环境.MULTI_TENANT;

const 跑 = (cmd, args, env = 环境) => execFileSync(cmd, args, { cwd: 仓库, env, stdio: "inherit" });
const 秒表 = () => { const t = Date.now(); return () => +((Date.now() - t) / 1000).toFixed(1); };
const 结果 = { at: new Date().toISOString(), scale: SCALE, users: 30, durationSec: 时长 / 1000, node: process.version, platform: `${process.platform}-${process.arch}` };

/* ---------- 1. 库和数据 ---------- */
if (!参数["reuse-db"] || !fs.existsSync(库)) {
  for (const f of [库, `${库}-journal`, `${库}-wal`, `${库}-shm`, 种子文件]) fs.rmSync(f, { force: true });
  const 计 = 秒表();
  跑("npx", ["prisma", "db", "push", "--skip-generate"], { ...环境, NODE_ENV: "development" });
  跑("npx", ["tsx", "scripts/perf/enterprise-seed.ts"], { ...环境, NODE_ENV: "development", SCALE: String(SCALE), OUT: 名单文件, EXTRA: 加一组 ? "1" : "" });
  结果.seedSec = 计();
}
const 种子 = fs.existsSync(种子文件) ? JSON.parse(fs.readFileSync(种子文件, "utf8")) : { extra: false };
if (!!种子.extra !== 加一组) throw new Error(`${库} 是${种子.extra ? "加了一组" : "没加那组"}的数据，这次${加一组 ? "带了" : "没带"} --extra：去掉 --reuse-db 重造，或换个输出目录`);
结果.seed = 种子;
结果.dbMB = +(fs.statSync(库).size / 1048576).toFixed(1);
const 名单 = JSON.parse(fs.readFileSync(名单文件, "utf8"));

/* ---------- 2. 生产构建 + 启动 ---------- */
if (!参数["skip-build"]) {
  const 计 = 秒表();
  跑("npx", ["next", "build"]);
  结果.buildSec = 计();
}
const 服务 = spawn("npx", ["next", "start", "--port", String(端口)], { cwd: 仓库, env: 环境, stdio: ["ignore", "pipe", "pipe"], detached: true });
const 服务日志 = fs.createWriteStream(path.join(输出, "server.log"));
服务.stdout.pipe(服务日志);
服务.stderr.pipe(服务日志);
const 收尾 = () => { try { process.kill(-服务.pid, "SIGTERM"); } catch { /* 已经退了 */ } };
process.on("exit", 收尾);
process.on("SIGINT", () => process.exit(130));

for (let i = 0; ; i++) {
  if (i > 120) throw new Error("服务 60 秒没起来，看 server.log");
  try { if ((await fetch(`${站}/login`)).ok) break; } catch { /* 还没起来 */ }
  await 等(500);
}

/* ---------- 3. 会话票据 ---------- */
const 钥 = new TextEncoder().encode(密钥);
for (const u of 名单) {
  u.cookie = `crm_session=${await new SignJWT({ sub: u.id, ims: Date.now() }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("7d").sign(钥)}`;
}

const 页面 = [
  { 名: "首页", 路径: () => "/dashboard" },
  { 名: "客户列表", 路径: () => "/customers" },
  { 名: "客户详情", 路径: (u) => `/customers/${u.customers[Math.floor(Math.random() * u.customers.length)]}` },
  { 名: "商机列表", 路径: () => "/opportunities" },
  { 名: "商机看板", 路径: () => "/opportunities/pipeline" },
  { 名: "跟进记录", 路径: () => "/follow-ups" },
  { 名: "跟进计划", 路径: () => "/follow-ups/plans" },
  { 名: "订单", 路径: () => "/orders" },
];
const 方式 = ["HTML", "RSC"];

async function 开(u, 页, 法) {
  const p = 页.路径(u);
  const headers = { cookie: u.cookie };
  if (法 === "RSC") headers.RSC = "1";
  const t = performance.now();
  try {
    // Next 16 校验 _rsc：它得等于按 Next-Router-State-Tree 等头算出的哈希，对不上就 307 到对的地址（10-24 第一轮全红就是这个）。
    // 这里不带路由树头，哈希就是空串、_rsc 留空；服务端从根整棵树重出，比真实站内切页（只出变了的那段）更重，量出来偏保守
    const r = await fetch(`${站}${p}${法 === "RSC" ? "?_rsc=" : ""}`, { headers, redirect: "manual" });
    const body = await r.arrayBuffer();
    const ms = performance.now() - t;
    // 被弹回登录页也算错：那说明票据没认，量的就不是这页了
    const ok = r.status === 200;
    return { ms, ok, status: r.status, kb: body.byteLength / 1024 };
  } catch (e) {
    return { ms: performance.now() - t, ok: false, status: String(e?.cause?.code ?? e) };
  }
}

const 分位 = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)].toFixed(1); };
const 汇总 = (样本) => ({ n: 样本.length, errors: 样本.filter((x) => !x.ok).length, p50: 分位(样本.map((x) => x.ms), 0.5), p95: 分位(样本.map((x) => x.ms), 0.95), p99: 分位(样本.map((x) => x.ms), 0.99), kb: 分位(样本.map((x) => x.kb ?? 0), 0.5) });

/* 每人先把每页开一次：确认票据被认、页面都是 200，顺带把服务端热起来 */
const 坏 = [];
for (const u of 名单) for (const 页 of 页面) for (const 法 of 方式) {
  const r = await 开(u, 页, 法);
  if (!r.ok) 坏.push(`${u.id} ${页.名} ${法} → ${r.status}`);
}
if (坏.length) { console.error("热身有页面没打开：\n" + 坏.slice(0, 20).join("\n")); process.exit(1); }

/* ---------- 4. 单人基线 ---------- */
const 销售 = 名单.find((u) => u.role === "SALES");
结果.single = {};
for (const 页 of 页面) for (const 法 of 方式) {
  const 样本 = [];
  for (let i = 0; i < 15; i++) { const r = await 开(销售, 页, 法); if (i >= 3) 样本.push(r); }
  结果.single[`${页.名} ${法}`] = 汇总(样本);
}

/* ---------- 5. 30 人同时用 ---------- */
const 内存 = [];
const 量内存 = () => {
  try {
    const 表 = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
    const 子孙 = new Set([服务.pid]);
    for (let 变 = true; 变;) { 变 = false; for (const [pid, ppid] of 表) if (子孙.has(ppid) && !子孙.has(pid)) { 子孙.add(pid); 变 = true; } }
    内存.push(表.filter(([pid]) => 子孙.has(pid)).reduce((s, [, , rss]) => s + rss, 0) / 1024);
  } catch { /* 量不到就算了 */ }
};
const 内存表 = setInterval(量内存, 5000);
const 样本 = [];
const 截止 = Date.now() + 时长;
await Promise.all(名单.map(async (u) => {
  await 等(Math.random() * 2000);
  while (Date.now() < 截止) {
    const 页 = 页面[Math.floor(Math.random() * 页面.length)];
    const 法 = 方式[Math.floor(Math.random() * 2)];
    样本.push({ ...(await 开(u, 页, 法)), 页: 页.名, 法, role: u.role });
    await 等(1000 + Math.random() * 2000);
  }
}));
clearInterval(内存表);
量内存();

结果.load = { all: 汇总(样本), pages: {}, byRole: {} };
for (const 页 of 页面) for (const 法 of 方式) 结果.load.pages[`${页.名} ${法}`] = 汇总(样本.filter((x) => x.页 === 页.名 && x.法 === 法));
for (const role of ["ADMIN", "MANAGER", "SALES"]) 结果.load.byRole[role] = 汇总(样本.filter((x) => x.role === role));
结果.load.rps = +(样本.length / (时长 / 1000)).toFixed(1);
结果.serverRssMB = { max: 内存.length ? Math.round(Math.max(...内存)) : null, last: 内存.length ? Math.round(内存.at(-1)) : null };
结果.errorsSample = 样本.filter((x) => !x.ok).slice(0, 10).map((x) => `${x.页} ${x.法} ${x.role} → ${x.status}`);

const 超 = Object.entries(结果.load.pages).filter(([, v]) => v.p95 != null && v.p95 >= 门槛).map(([k, v]) => `${k} p95 ${v.p95} ms`);
结果.pass = 超.length === 0 && 结果.load.all.errors === 0;
结果.over = 超;
fs.writeFileSync(path.join(输出, "result.json"), JSON.stringify(结果, null, 2));

/* ---------- 6. 报告 ---------- */
const 行 = (k, v) => `| ${k} | ${v.n} | ${v.p50} | **${v.p95}** | ${v.p99} | ${v.errors} | ${Math.round(v.kb)} |`;
const md = [
  `# 企业版压测：30 人 × ${SCALE} 倍数据`,
  "",
  `${结果.at}，${结果.platform}，Node ${结果.node}。数据：${种子.extra ? "原来那些 + 加的一组（逾期跟进计划、带节点的订单，--extra）" : "原来那些（不带 --extra）"}${种子.plans ? `，跟进计划 ${种子.plans} 条、订单 ${种子.orders} 张、订单节点 ${种子.orderNodes} 个` : ""}。库 ${结果.dbMB} MB；压测 ${时长 / 1000} 秒，${结果.load.rps} 次/秒；服务端内存峰值 ${结果.serverRssMB.max} MB。`,
  "",
  `**裁判：各页 p95 < ${门槛} ms 且没有出错 → ${结果.pass ? "绿" : "红"}**${超.length ? `（超了：${超.join("；")}）` : ""}${结果.load.all.errors ? `（出错 ${结果.load.all.errors} 次：${结果.errorsSample.join("；")}）` : ""}`,
  "",
  "## 30 人同时用（ms，响应体读完为止）",
  "",
  "| 页面 | 次数 | p50 | p95 | p99 | 出错 | 大小 KB |",
  "|---|---|---|---|---|---|---|",
  ...Object.entries(结果.load.pages).map(([k, v]) => 行(k, v)),
  行("合计", 结果.load.all),
  "",
  "按角色：" + Object.entries(结果.load.byRole).map(([k, v]) => `${k} p95 ${v.p95} ms（${v.n} 次）`).join("；"),
  "",
  "## 单人基线（一个销售顺序打开，每页 12 次）",
  "",
  "| 页面 | 次数 | p50 | p95 | p99 | 出错 | 大小 KB |",
  "|---|---|---|---|---|---|---|",
  ...Object.entries(结果.single).map(([k, v]) => 行(k, v)),
  "",
].join("\n");
fs.writeFileSync(path.join(输出, "result.md"), md);
console.log(md);
if (process.env.GATE === "1" && !结果.pass) process.exit(1);
process.exit(0);
