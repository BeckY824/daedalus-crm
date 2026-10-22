#!/usr/bin/env node
/**
 * 团队版五台真实对齐（2026-10-04，上线前测试 4.1）：`npm run test:team`。
 *
 * 为什么要这个：团队同步原来只有单进程单测（一台真客户端，其余用函数模拟），五人实测是手点的、脚本躺在会话临时目录、
 * 没有任何断言。这里把那一遍做成一条命令：一个本机云端（托管模式 + 中转）+ 5 台桌面端本地服务（和 Electron 里跑的
 * 同一个 server-bundle）+ 每台一个模拟壳（真壳前台每 8 秒戳一次 /api/desktop/sync），从注册到移除成员一路断言。
 *
 * 动作一律走 HTTP：自动登录走 /api/desktop/session，改数据调的是界面按钮背后的同一个 Server Action，
 * 「业务员看不到别人的客户」看的是他那台的页面。只有「每台都有全队数据」这类界面上本来就看不到的事才只读打开库核对。
 *
 * 环境变量：TEAM_SIM_PORT（起始端口，默认 3520，云端用它、5 台用后面 5 个）、TEAM_SIM_SEED（老板先录几位客户，默认 30）、
 * TEAM_SIM_BUILD（1 = 强制重新 build:server，0 = 不管新旧直接用）、TEAM_SIM_KEEP=1（跑完留着临时目录看日志）、
 * TEAM_SIM_OLD_BUNDLE（混版本，2026-10-06 测试分期 E.2：给一份旧版本的 server-bundle 目录，sun 那台就用它跑——
 * 前面照常参加，外贸段「转订单」之后换成这一版重启，核对它从头重拉、补齐旧版本收不下的档案和订单）。
 * TEAM_SIM_SCOPED（2026-10-13 范围同步）：不设 = 旧协议（全队包，和以前一模一样）；
 *   1 / --scoped = 只有云端开 CRM_SCOPED_SYNC=1（桌面端不设，和真用户双击打开一样），新建的团队一开始就按范围同步：
 *     业务员库里只该有本人 + 公海 + 全队共享 + 本人条目；
 *   migrate / --migrate = 先按旧协议建团队、同步、看可见性，再带开关重启云端 → 老板那台先带 CRM_SCOPED_SYNC=0（应急开关）
 *     核对不迁移、业务员被告知等老板 → 老板那台不带任何变量重启，**只凭服务端开关**自动迁移 → 业务员清理失权副本，之后按范围断言。
 * TEAM_SIM_DESK_FLAG（2026-10-14 候选 9）：桌面端那几台的 CRM_SCOPED_SYNC，默认空（真用户不会设）；设 1 可复现候选 8 之前「两边都设」的跑法。
 * 不改业务代码迁就它：哪一步不对就红，打印哪一步、哪台、期望和实际。
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { 动作 } from "./actions.mjs";
import { DatabaseSync } from "node:sqlite";
import { 根, 包, 断言失败, 等到, 判, 停, 显示, 起进程, 关掉, 全关, 日志尾巴, 同步跑, 会话, 读动作表, 调动作, 查库 } from "./lib.mjs";
import { 查越权, 字节残留 } from "./scope-check.mjs";

const 起始端口 = Number(process.env.TEAM_SIM_PORT || 3520);
const 种子数 = Math.min(90, Math.max(1, Number(process.env.TEAM_SIM_SEED || 30)));
const 留着 = process.env.TEAM_SIM_KEEP === "1";
/**
 * 范围同步模式（见文件头）。CRM_SCOPED_SYNC=1 直接跑（以前的习惯）当成 TEAM_SIM_SCOPED=1；
 * 旧协议模式显式给子进程空值，外面 shell 里留着的 CRM_SCOPED_SYNC 不会混进来
 */
const 范围模式 = process.argv.includes("--migrate") ? "migrate" : process.argv.includes("--scoped") ? "1" : (process.env.TEAM_SIM_SCOPED || (process.env.CRM_SCOPED_SYNC === "1" ? "1" : "")).trim();
if (!["", "0", "1", "migrate"].includes(范围模式)) throw new Error(`TEAM_SIM_SCOPED 只认 1 或 migrate（现在是「${范围模式}」）`);
/** 云端现在带不带 CRM_SCOPED_SYNC=1（migrate：迁移那一步重启时才打开）。桌面端不跟着它：见 起桌面端 */
let 开关 = 范围模式 === "1";
/** 桌面端的 CRM_SCOPED_SYNC：默认空（候选 9 起老板迁移只看服务端开关）；单台可以用 t.本机开关 覆盖（migrate 里试应急开关 0） */
const 桌面开关 = (process.env.TEAM_SIM_DESK_FLAG ?? "").trim();
/** 现在按哪套断言：false = 全队包（每台都有全队数据），true = 范围（业务员只有本人 + 公海） */
let 范围 = 范围模式 === "1";
const 模式名 = { "": "旧协议", "0": "旧协议", "1": "范围同步", migrate: "旧协议 → 范围同步迁移" }[范围模式];
const 批 = crypto.randomBytes(2).toString("hex");
const 密码 = `Sim-${crypto.randomBytes(6).toString("hex")}`;
const 运营口令 = crypto.randomBytes(12).toString("hex");
// 中途要把云端、某一台关掉再起（4.5 离线 / 中转断了）：密钥整轮固定，重起之后会话和设备令牌照旧认
const 云密钥 = crypto.randomBytes(32).toString("hex");
const 前台间隔 = 8_000; // desktop/sync.js 前台节奏
const 首轮 = 10_000; // desktop/sync.js 开始() 第一轮

/** 五台：老板建团队，其余四位凭邀请码加入 */
const 名单 = ["boss", "wang", "li", "zhao", "sun"];
const 老板 = "boss";
const 业务员 = 名单.filter((n) => n !== 老板);
/**
 * 4.5「老库升级后再进团队」：这一台不是新装的，是从老版本（0.46.14）一路用过来的库——
 * 老版本的表结构 + 老版本的迁移 + 模板三个账号 + 管理员名下两位老客户。本地服务一起来就按当前迁移升级，
 * 之后和别人一样凭邀请码加入：改身份、把老客户整份带进团队
 */
const 老库台 = "zhao";
const 老库版本 = "v0.46.14";
/** 混版本：这一台先跑旧版本的 server-bundle，中途升级（见文件头 TEAM_SIM_OLD_BUNDLE） */
const 旧包 = process.env.TEAM_SIM_OLD_BUNDLE ? path.resolve(process.env.TEAM_SIM_OLD_BUNDLE) : null;
const 旧台 = 旧包 ? "sun" : null;
if (旧包 && 范围模式 && 范围模式 !== "0") throw new Error("TEAM_SIM_OLD_BUNDLE 不能和 TEAM_SIM_SCOPED 一起用：开了范围同步，旧版本客户端会被中转拒掉（409 请升级），没有可比的东西");

const 临时 = fs.mkdtempSync(path.join(os.tmpdir(), "team-sim-"));

/* ---------------- 每一步打一行：第几步、做了什么、用了多久 ---------------- */
let 步号 = 0;
const 总起 = Date.now();
async function 步(名, fn) {
  步号++;
  const 起 = Date.now();
  process.stdout.write(`[${String(步号).padStart(2)}] ${名} … `);
  const r = await fn();
  console.log(`✓ ${((Date.now() - 起) / 1000).toFixed(1)}s${r?.说 ? `（${r.说}）` : ""}`);
  return r;
}
const 观察 = [];
const 没成的轮 = [];

/* ---------------- 0. 产物：server-bundle 比源码旧就重新装配 ---------------- */
function 最新改动(dir) {
  let t = 0;
  const 走 = (p) => {
    const s = fs.statSync(p);
    if (s.isDirectory()) {
      for (const n of fs.readdirSync(p)) if (n !== "generated" && n !== "node_modules") 走(path.join(p, n));
    } else t = Math.max(t, s.mtimeMs);
  };
  if (fs.existsSync(dir)) 走(dir);
  return t;
}
function 要不要构建() {
  if (process.env.TEAM_SIM_BUILD === "1") return "TEAM_SIM_BUILD=1";
  const 入口 = path.join(包, "entry.js");
  if (!fs.existsSync(入口) || !fs.existsSync(path.join(根, ".next/BUILD_ID"))) return "还没有 desktop/server-bundle";
  if (process.env.TEAM_SIM_BUILD === "0") return null;
  const 包时间 = fs.statSync(入口).mtimeMs;
  const 源 = Math.max(...["src", "prisma", "migrations", "desktop/server-entry.js", "next.config.ts", "package.json"].map((p) => 最新改动(path.join(根, p))));
  return 源 > 包时间 ? "源码比 server-bundle 新" : null;
}

/* ---------------- 进程 ---------------- */
const 云端口 = 起始端口;
const 云址 = `http://127.0.0.1:${云端口}`;
const 云 = new 会话("云端", 云址);
const 云目录 = path.join(临时, "cloud");
const 进程 = {};

function 云端环境() {
  return {
    ...process.env,
    NODE_ENV: "production",
    MULTI_TENANT: "1",
    CONTROL_DATABASE_URL: `file:${云目录}/control.db`,
    WORKSPACE_DIR: `${云目录}/ws`,
    DATABASE_URL: `file:${云目录}/never.db`,
    SYNC_DIR: `${云目录}/sync`,
    AUTH_SECRET: 云密钥,
    COOKIE_SECURE: "false",
    ADMIN_TOKEN: 运营口令,
    PORT: String(云端口),
    HOSTNAME: "127.0.0.1",
    // 仓库根目录的 .env 不许混进来（开发库、真模型 Key）：显式给空值，Next 就不会再拿 .env 里的
    LLM_API_KEY: "",
    LLM_BASE_URL: "",
    LLM_MODEL: "",
    SIGNUP_VERIFY: "",
    SIGNUP_REDIRECT: "",
    CRM_SCOPED_SYNC: 开关 ? "1" : "",
  };
}

const 台 = Object.fromEntries(
  名单.map((n, i) => {
    const 端口 = 起始端口 + 1 + i;
    const 目录 = path.join(临时, `desk-${n}`);
    return [n, { 名: n, 包: n === 旧台 ? 旧包 : 包, 端口, 目录, 库: path.join(目录, "crm.db"), 令牌: `sim-${n}-${crypto.randomBytes(12).toString("hex")}`, 密钥: crypto.randomBytes(32).toString("hex"), 会: new 会话(n, `http://127.0.0.1:${端口}`), 壳: { 轮: 0, 最近: [], 停: false } }];
  }),
);

/** 云端：同一个数据目录、同一个密钥，重起之后会话、设备令牌、团队都还在；带不带 CRM_SCOPED_SYNC 看当时的 开关 */
const 起云端 = () => 起进程("云端", process.execPath, [path.join(根, "node_modules/next/dist/bin/next"), "start", "-p", String(云端口), "-H", "127.0.0.1"], { cwd: 根, env: 云端环境(), 日志: path.join(临时, "cloud.log") });

function 起桌面端(t) {
  return 起进程(t.名, process.execPath, ["entry.js"], {
    cwd: t.包,
    日志: path.join(临时, `${t.名}.log`),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(t.端口),
      HOSTNAME: "127.0.0.1",
      CRM_DATA_DIR: t.目录,
      DATABASE_URL: `file:${t.库}`,
      AUTH_SECRET: t.密钥,
      COOKIE_SECURE: "false",
      MULTI_TENANT: "",
      DESKTOP_LOCAL: "1",
      DESKTOP_TOKEN: t.令牌,
      CRM_CLOUD_URL: 云址,
      CRM_SCOPED_SYNC: t.本机开关 ?? 桌面开关,
    },
  });
}

/** 端口被别的服务占着：健康检查会打到别人身上、断言全乱。起之前先试着占一下 */
function 端口空着(端口) {
  return new Promise((r) => {
    const s = net.createServer();
    s.once("error", () => r(false));
    s.listen(端口, "127.0.0.1", () => s.close(() => r(true)));
  });
}

/** 等服务起来：进程先退了就别傻等 60 秒，带着日志尾巴直接红 */
async function 等起来(项, 会, 哪台) {
  await 等到({
    步骤: "服务起来", 哪台, 期望: "/api/health 回 200",
    取: async () => {
      if (项.退了) throw new Error(`进程已经退出（${项.退出码}）：\n${日志尾巴(项.日志, 15)}`);
      return 会.json("GET", "/api/health");
    },
    满足: (r) => r.状态 === 200, 超时: 60_000,
  });
}

/** 模拟壳：照 desktop/sync.js 的节奏，起来 10 秒后第一轮，之后每轮结束再等 8 秒（前台） */
async function 壳(t) {
  await 停(首轮);
  while (!t.壳.停) {
    const 起 = Date.now();
    const at = new Date().toISOString().slice(11, 19);
    try {
      // 和真壳一样只带令牌、不带会话 cookie（窗口关着也要同步）
      const res = await fetch(`${t.会.base}/api/desktop/sync`, { method: "POST", headers: { "x-desktop-token": t.令牌 }, signal: AbortSignal.timeout(120_000) });
      const r = { 状态: res.status, json: await res.json().catch(() => null) };
      t.壳.最近.push({ at, 用时: Date.now() - 起, r: r.json ?? r.状态 });
      // 同步没成的轮次不当场判红（下一轮会再来，真壳也是这样），收尾时列出来：被移出的那台说「不在这个团队里」是预期的
      // 开通之前的「还没开通」也是预期的（建团队那一下就会推一次）
      if (!r.json?.ok && !/还没开通/.test(r.json?.error ?? "") && !(t.壳.该被移出 && /不在这个团队/.test(r.json?.error ?? ""))) 没成的轮.push(`${at} ${t.名}：${String(r.json?.error ?? r.状态).replace(/\s+/g, " ").slice(0, 160)}`);
    } catch (e) {
      t.壳.最近.push({ at, 错: String(e.message ?? e) });
      没成的轮.push(`${at} ${t.名}：请求失败 ${String(e.message ?? e).slice(0, 120)}`);
    }
    t.壳.最近 = t.壳.最近.slice(-8);
    t.壳.轮++;
    await 停(前台间隔);
  }
}

/* ---------------- 4.5 老库：老版本的 schema + 老版本的迁移 + 人 + 两位老客户（同 tests/r2-shell-upgrade 的造法） ---------------- */
const 老客户 = [
  { id: "old_c1", 名: "", 号: "13912340001" },
  { id: "old_c2", 名: "", 号: "13912340002" },
];
function 造老库(t) {
  const 临schema = path.join(临时, "old-schema.prisma");
  fs.writeFileSync(临schema, 同步跑("git", ["show", `${老库版本}:prisma/schema.prisma`]));
  const 建表 = 同步跑(process.execPath, [path.join(根, "node_modules/prisma/build/index.js"), "migrate", "diff", "--from-empty", "--to-schema-datamodel", 临schema, "--script"]);
  const db = new DatabaseSync(t.库);
  try {
    db.exec(建表);
    const 迁移 = 同步跑("git", ["ls-tree", "--name-only", 老库版本, "migrations/"]).split("\n").filter((f) => f.endsWith(".sql")).sort();
    for (const f of 迁移) {
      try {
        db.exec(同步跑("git", ["show", `${老库版本}:${f}`]));
      } catch (e) {
        if (!/duplicate column name|already exists/i.test(String(e?.message))) throw e;
      }
    }
    const 插 = (表, 行) => db.prepare(`INSERT INTO "${表}" (${Object.keys(行).map((k) => `"${k}"`).join(",")}) VALUES (${Object.keys(行).map(() => "?").join(",")})`).run(...Object.values(行));
    const t0 = Date.now() - 30 * 86_400_000;
    插("User", { id: "u_admin", email: "admin", name: "管理员", title: "系统管理员", role: "ADMIN", password: "x", active: 1, createdAt: t0, updatedAt: t0 });
    插("User", { id: "u_zs", email: "zhangsan", name: "张三", title: "销售", role: "SALES", password: "x", active: 1, createdAt: t0 + 1, updatedAt: t0 + 1 });
    插("User", { id: "u_ls", email: "lisi", name: "李四", title: "销售", role: "SALES", password: "x", active: 1, createdAt: t0 + 2, updatedAt: t0 + 2 });
    for (const [i, c] of 老客户.entries()) {
      c.名 = 名(老库台, `老库客户${i + 1}`);
      插("Customer", { id: c.id, name: c.名, phone: c.号, salesOwnerId: "u_admin", createdAt: t0 + 10 + i, updatedAt: t0 + 10 + i });
      插("FollowUp", { id: `${c.id}_f`, type: "PHONE", title: "", content: `${c.名}-老跟进`, status: "已完成", occurredAt: t0 + 20 + i, customerId: c.id, ownerId: "u_admin", createdAt: t0 + 20 + i, updatedAt: t0 + 20 + i });
    }
    db.exec("PRAGMA journal_mode = WAL");
  } finally {
    db.close();
  }
}

/** 这台关机（按进程号关本地服务）；壳照跑，这期间每轮都是「请求失败」，和真壳一样不判红 */
async function 关机(t) {
  await 关掉(进程[t.名]);
}
/** 开机：同一个数据目录、同一个令牌和密钥再起一次，自动登录一下（会话 cookie 本来也还认） */
async function 开机(t) {
  进程[t.名] = 起桌面端(t);
  await 等起来(进程[t.名], t.会, t.名);
  const s = await t.会.页面(`/api/desktop/session?t=${t.令牌}`);
  判(s.状态 === 307, { 步骤: "重新开机后自动登录", 哪台: t.名, 期望: "307", 实际: `${s.状态} → ${s.跳到}` });
}

/** 直接写这台的库（关着机时模拟「离线那台在本机改的」；触发器照记，开机后推出去） */
function 改库(t, sql, ...参数) {
  const db = new DatabaseSync(t.库);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return db.prepare(sql).run(...参数);
  } finally {
    db.close();
  }
}

/* ---------------- 读数：库里的（全队数据）和页面上的（这个人看得到的） ---------------- */
const 数 = (t, sql, ...p) => Number(Object.values(查库(t.库, sql, ...p)[0] ?? { n: 0 })[0]);
const 客户数 = (t) => 数(t, "SELECT COUNT(*) AS n FROM Customer");
const 跟进数 = (t) => 数(t, "SELECT COUNT(*) AS n FROM FollowUp");
const 客户 = (t, id) => 查库(t.库, "SELECT id, name, school, major, grade, remark, salesOwnerId FROM Customer WHERE id = ?", id)[0] ?? null;
const 在公海 = (t, id) => 数(t, "SELECT COUNT(*) AS n FROM CustomerPool WHERE customerId = ?", id) > 0;
const 读团队文件 = (t) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(t.目录, ".team.json"), "utf8"));
  } catch {
    return null;
  }
};
const 页面 = async (t, 路径) => {
  const p = await t.会.页面(路径);
  if (p.状态 !== 200) throw new Error(`${路径} 回了 ${p.状态}${p.跳到 ? ` → ${p.跳到}` : ""}`);
  return p.text;
};
/** 客户列表一页最多 100 位：别用 keyword 查（筛选框会把关键字原样画回页面，查「看不到」会误报） */
const 客户列表 = (t, 额外 = "") => 页面(t, `/customers?pageSize=100${额外}`);

/* ---------------- 范围同步（2026-10-13）：业务员那台库里该有什么、没有什么 ---------------- */
/** 还在团队里的业务员（退出、被移出之后拿掉）：越权检查按「本人 + 公海」核他们 */
const 在队业务员 = new Set(业务员);
/** scope-policy 的 范围父表 和 tables.ts 的 同步表：从源码读，免得脚本里抄一份、源码改了这边不知道 */
let 范围表 = null;
function 读范围表() {
  if (!范围表) {
    const 码 = "Promise.all([import('./src/lib/sync/scope-policy.ts'), import('./src/lib/sync/tables.ts')]).then(([a, b]) => console.log(JSON.stringify({ 父表: (a.default ?? a).范围父表, 同步表: (b.default ?? b).同步表 })))";
    范围表 = JSON.parse(同步跑(path.join(根, "node_modules/.bin/tsx"), ["-e", 码]));
    if (!范围表.父表?.FollowUp || !范围表.同步表?.includes("Customer")) throw new Error(`读不到 范围父表 / 同步表：${显示(范围表)}`);
  }
  return 范围表;
}
/** 建团队之后记下（越权检查查「哪台都已删掉」的记录当时归谁要用控制库里这个团队的索引） */
let 范围团队id = null;
/** 这台库里越权的行（以老板那台为准）。含公海 = false：退出 / 被移出之后只该有本人的 */
const 越权 = (n, 含公海 = true) => 查越权({ 库: 台[n].库, 老板库: 台[老板].库, 我: 台[n].我, ...读范围表(), 含公海, 控制库: path.join(云目录, "control.db"), 团队id: 范围团队id });
/** 库文件原始字节里还搜得到的「不该有的客户」（电话 / 名字；SQL 查不到的空闲页、页内空隙、WAL 也算） */
/** 各台的人自己在本机敲过的号码（合并疑似重复那步：业务员录的和老板那份是同一个号，见 scope-check 字节残留 的豁免） */
const 自己录过的号 = {};
const 字节 = (n, 含公海 = true) => 字节残留({ 库: 台[n].库, 老板库: 台[老板].库, 我: 台[n].我, 含公海, 豁免: 自己录过的号[n] ?? [] }).filter((x) => x.命中.length).map((x) => `${x.文件}：${x.命中.length} 位（${x.命中.slice(0, 5).join("、")}）`);
/** 等到这几台库里没有越权的行、库文件字节里也没有删掉的客户（每台最多两轮壳） */
async function 核越权(说明, 谁们 = [...在队业务员], 含公海 = true) {
  const 查了 = [];
  for (const n of 谁们) {
    const { 值 } = await 等到({
      步骤: `范围：${说明}后本机库里没有越权的行、库文件字节里也搜不到`, 哪台: n, 期望: `只有本人${含公海 ? " + 公海" : ""}客户及其子记录、全队共享、本人条目（含 _sync_* / ImportRow / 全文）；crm.db / WAL 原始字节里没有不该有的客户的电话和名字`,
      取: () => ({ ...越权(n, 含公海), 字节: 字节(n, 含公海) }), 满足: (v) => v.越权.length === 0 && v.字节.length === 0,
      超时: 前台间隔 * 2 + 6_000, 迟到也报: 20_000,
    }).catch((e) => {
      // 把越权的行列清楚（等到 只显示 600 字）
      if (e instanceof 断言失败) {
        try {
          const v = 越权(n, 含公海).越权;
          e.message += `\n    越权 ${v.length} 条：\n      ${v.slice(0, 15).join("\n      ")}\n    字节残留：${字节(n, 含公海).join("；") || "无"}`;
        } catch { /* 读不了库就照原样报 */ }
      }
      throw e;
    });
    查了.push(`${n} ${值.查了}`);
  }
  return 查了.join("、");
}
/** 这位客户和挂在他下面的东西在这台库里还剩几行（范围：失权之后应当一行不剩） */
const 子表们 = [["Customer", "id"], ["CustomerPool", "customerId"], ["CustomerExtra", "customerId"], ["FollowUp", "customerId"], ["FollowPlan", "customerId"], ["Contract", "customerId"], ["TradeOrder", "customerId"], ["Opportunity", "customerId"], ["Contact", "customerId"]];
const 残留 = (t, id) => Object.fromEntries(子表们.map(([表, 列]) => [表, 数(t, `SELECT COUNT(*) AS n FROM "${表}" WHERE "${列}" = ?`, id)]).filter(([, n]) => n > 0));
async function 等没了(t, c, 步骤, 超时 = 前台间隔 * 2 + 4_000) {
  await 等到({ 步骤, 哪台: t.名, 期望: `库里「${c.名字 ?? c.名 ?? c.id}」和它的跟进 / 计划 / 档案 / 订单一行不剩`, 取: () => 残留(t, c.id), 满足: (v) => Object.keys(v).length === 0, 超时, 迟到也报: 20_000 });
}
/**
 * 「这台收不到」要有分量：先保证这台在写完之后完整跑过一轮同步。直接戳两次 /api/desktop/sync——
 * 第一次可能复用正在跑的那一轮（开始得比写早），第二次一定是写完之后才开始的
 */
async function 跑完一轮(t) {
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${t.会.base}/api/desktop/sync`, { method: "POST", headers: { "x-desktop-token": t.令牌 }, signal: AbortSignal.timeout(120_000) }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (!r?.ok) 观察.push(`${t.名} 手动戳的一轮同步没成：${String(r?.error ?? "").slice(0, 100)}`);
  }
}
/** 收不到：先各跑完一轮，再看库里确实没有 */
async function 都收不到(谁们, c, 步骤) {
  await Promise.all(谁们.map((n) => 跑完一轮(台[n])));
  for (const n of 谁们) 判(Object.keys(残留(台[n], c.id)).length === 0, { 步骤, 哪台: n, 期望: `库里没有「${c.名字 ?? c.id}」（跑完一轮之后）`, 实际: 残留(台[n], c.id) });
}

let 表;
// 旧版本那台用它自己那份动作表（Server Action 的 id 跟着构建变）
const 调 = (t, 键, 参数, opt) => 调动作(t.会, t.表 ?? 表, 键, 参数, opt);
/** 这一台跑的是不是这一版（混版本时旧版本那台升级前不是） */
const 新版 = (n) => n !== 旧台 || Boolean(台[n].已升级);

/** 和新建客户表单交的一样。负责人：表单默认填「我」（进团队之后人多了，不填会被拒）；一个人用时不填，服务端取唯一那位 */
function 新客户(名字, 号, 负责人) {
  return { name: 名字, phone: 号, school: null, grade: null, major: null, followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null, remark: null, salesOwnerId: 负责人, channelId: null, referrerCustomerId: null };
}
let 号段 = 0;
const 下一个号 = () => `138${String(10_000_000 + ++号段 * 7919).slice(-8)}`;
const 名 = (谁, 说) => `模拟${批}-${谁}-${说}`;

async function 录一位(t, 名字, 跟进几条 = 1, 负责人) {
  // 进过团队（哪怕又退了）：库里有同事的账号，负责人要填——表单默认填「我」（T-015）。老板可以直接分给业务员（范围同步用）
  const r = await 调(t, 动作.录客户, [新客户(名字, 下一个号(), 负责人 ?? (读团队文件(t) || t.进过团队 ? t.我 : null))]);
  判(r?.ok && r.id, { 步骤: "录客户", 哪台: t.名, 期望: "saveCustomer 返回 ok 和 id", 实际: r });
  const 跟进 = [];
  for (let i = 1; i <= 跟进几条; i++) {
    const 内容 = `${名字}-跟进${i}`;
    const f = await 调(t, 动作.记跟进, [{ customerId: r.id, type: "PHONE", title: "", content: 内容, status: "已完成", occurredAt: new Date().toISOString() }]);
    判(f?.ok, { 步骤: "记跟进", 哪台: t.名, 期望: "saveFollowUp 返回 ok", 实际: f });
    跟进.push(内容);
  }
  return { id: r.id, 名字, 跟进 };
}

/* ================================================================== */

async function 主线() {
  const 原因 = 要不要构建();
  if (原因) {
    console.log(`[构建] ${原因}：cd desktop && npm run build:server（含 next build，约 1 分钟）`);
    同步跑("npm", ["run", "build:server"], { cwd: path.join(根, "desktop"), 看得见: true });
  }
  // 多占一个：同一账号的第二台（wang2）用 起始端口 + 名单.length + 1
  for (let p = 云端口; p <= 云端口 + 名单.length + 1; p++) {
    if (!(await 端口空着(p))) throw new 断言失败({ 步骤: "端口", 期望: `${p} 空着`, 实际: "被占了：换一段，例如 TEAM_SIM_PORT=3620 npm run test:team" });
  }
  表 = 读动作表(path.join(包, ".next/server/server-reference-manifest.json"));
  for (const k of Object.values(动作)) if (!表.has(k)) throw new 断言失败({ 步骤: "读动作表", 期望: `构建产物里有 ${k}`, 实际: "没有（改过名字？）" });
  if (旧台) {
    台[旧台].表 = 读动作表(path.join(旧包, ".next/server/server-reference-manifest.json"));
    console.log(`混版本：${旧台} 那台先跑 ${旧包}`);
  }
  console.log(`临时目录 ${临时}；端口 ${云端口}–${云端口 + 名单.length}；批次 ${批}；${模式名}${开关 ? "（云端 CRM_SCOPED_SYNC=1）" : ""}${桌面开关 ? `（桌面端 CRM_SCOPED_SYNC=${桌面开关}）` : "（桌面端不设 CRM_SCOPED_SYNC）"}`);
  if (范围模式 && 范围模式 !== "0") 读范围表();

  await 步(`起本机云端（托管模式 + 中转，:${云端口}）`, async () => {
    fs.mkdirSync(`${云目录}/ws`, { recursive: true });
    fs.writeFileSync(path.join(云目录, "control.db"), "");
    同步跑(process.execPath, [path.join(根, "node_modules/prisma/build/index.js"), "db", "push", "--schema=prisma/control.prisma", "--skip-generate"], { env: 云端环境() });
    // 云端用 next start 跑仓库根目录那份构建（build:server 顺手产出的 .next）：standalone 那份不带 @prisma/client，
    // server-bundle 又裁掉了控制面引擎。会打一句「next start 不配 standalone」的提示，不影响
    进程.云 = 起云端();
    await 等起来(进程.云, 云, "云端");
  });

  await 步("注册 5 个云端账号、各自登录拿设备令牌", async () => {
    for (const [i, n] of 名单.entries()) {
      const t = 台[n];
      // 注册同一个 IP 一天最多 3 个：每人一个出口 IP（真实情况也是 5 个人在 5 个地方）
      const ip = { "x-forwarded-for": `10.77.${i}.${(Number.parseInt(批, 16) % 200) + 1}` };
      const 账号 = `${n}-${批}@sim.test`;
      const s = await 云.json("POST", "/api/account/signup", { target: 账号, password: 密码, agreed: true }, ip);
      判(s.状态 === 200 && s.json?.ok, { 步骤: "注册云端账号", 哪台: n, 期望: "200 {ok:true}", 实际: `${s.状态} ${s.text}` });
      const r = await 云.json("POST", "/api/account/token", { target: 账号, password: 密码, name: `sim-${n}` }, ip);
      判(r.状态 === 200 && r.json?.token && r.json?.account?.id, { 步骤: "登录云端账号", 哪台: n, 期望: "200 带 token 和 account.id", 实际: `${r.状态} ${r.text}` });
      t.账号 = r.json.account.id;
      t.我 = `acct_${t.账号}`;
      fs.mkdirSync(t.目录, { recursive: true });
      // 和桌面端登录动作写的一样（lib/desktop/cloud.ts 登录()）：令牌 + 账号，0600；目录归属记号
      fs.writeFileSync(path.join(t.目录, ".cloud.json"), JSON.stringify({ baseUrl: 云址, token: r.json.token, accountId: t.账号, name: r.json.account.name ?? n, contact: r.json.account.contact ?? 账号, models: [], loggedAt: new Date().toISOString() }), { mode: 0o600 });
      fs.writeFileSync(path.join(t.目录, ".owner"), t.账号, { mode: 0o600 });
    }
  });

  await 步(`${老库台} 那台是从 ${老库版本} 一路用过来的老库：管理员名下 ${老客户.length} 位老客户（起服务时按当前迁移升级）`, async () => {
    造老库(台[老库台]);
  });

  await 步("起 5 台桌面端本地服务（server-bundle）+ 模拟壳", async () => {
    for (const n of 名单) 进程[n] = 起桌面端(台[n]);
    for (const n of 名单) {
      const t = 台[n];
      await 等起来(进程[n], t.会, n);
      void 壳(t);
    }
  });

  await 步("各台自动登录、选「通用」模版", async () => {
    for (const n of 名单) {
      const t = 台[n];
      const s = await t.会.页面(`/api/desktop/session?t=${t.令牌}`);
      判(s.状态 === 307 && t.会.罐.has("crm_session"), { 步骤: "自动登录", 哪台: n, 期望: "307 且发了 crm_session", 实际: `${s.状态} → ${s.跳到}` });
      const r = await 调(t, 动作.选模版, ["general"]);
      判(r?.ok, { 步骤: "选模版", 哪台: n, 期望: "{ok:true}", 实际: r });
    }
  });

  const 老 = 台[老板];
  const 种子 = [];
  await 步(`老板先录 ${种子数} 位客户、每位 2 条跟进（团队开起来之前的老数据）`, async () => {
    for (let i = 1; i <= 种子数; i++) 种子.push(await 录一位(老, 名(老板, `老客户${i}`), 2));
  });

  let 码, 团队id;
  await 步("老板建团队，运营台开通", async () => {
    const r = await 调(老, 动作.建团队, [`模拟团队${批}`]);
    判(r?.ok && /^DT2\./.test(r.邀请码 ?? ""), { 步骤: "建团队", 哪台: 老板, 期望: "ok 且邀请码以 DT2. 开头", 实际: r });
    码 = r.邀请码;
    团队id = 码.split(".")[1];
    范围团队id = 团队id;
    const k = await 调动作(云, 表, 动作.开通团队, [{ token: 运营口令, teamId: 团队id, months: 1, seats: 5, amount: 149.5, note: "team-sim" }], { 查询: `?token=${运营口令}` });
    判(k?.ok, { 步骤: "运营台开通团队", 哪台: "云端", 期望: "{ok:true}", 实际: k });
    /*
      真实顺序：建团队 → 运营台人工开通（分钟级）→ 同事加入，加入时老板的老数据早就在云上了。
      这里开通只隔零点几秒，建团队那一下的自动推送撞上「还没开通」，老数据要等老板的壳下一轮（≤ 8 秒）才上去；
      不等这一下，下面「加入后 15 秒对齐」量的就是两跳 8 秒，而不是加入的人拉一次要多久
    */
    if (范围) {
      /*
        范围同步：开关开着时新团队没有单独的「范围团队」入口——老板那台下一轮看到「服务端开关开、我是老板、还是 legacy」就走老板迁移
        （候选 9 起桌面端不设任何环境变量：只凭服务端开关）
        （备份 → 冻结旧流 → 推完整起点 → commit），控制库 SyncPrivacy 变 ready 才放业务员进来。老数据随起点上云（不计在 last.推 里）
      */
      const 控制库 = path.join(云目录, "control.db");
      const { 用时 } = await 等到({
        步骤: "开通后老板那台完成范围迁移、老数据随起点上云", 哪台: 老板, 期望: "控制库 SyncPrivacy = ready、SyncScopedBatch > 0；.team.json scoped.stage = ready、没有 lastError",
        取: () => { const c = 读团队文件(老); return { 阶段: 查库(控制库, "SELECT stage FROM SyncPrivacy WHERE teamId = ?", 团队id)[0]?.stage ?? null, 包: 数({ 库: 控制库 }, "SELECT COUNT(*) AS n FROM SyncScopedBatch WHERE teamId = ?", 团队id), 本机: c?.scoped?.stage ?? null, lastError: c?.lastError ?? null }; },
        满足: (v) => v.阶段 === "ready" && v.包 >= 种子数 && v.本机 === "ready" && !v.lastError, 超时: 前台间隔 * 2 + 6_000, 迟到也报: 20_000,
      });
      判(fs.existsSync(path.join(老.目录, "backups", "before-scoped-sync-migration.db")) && !fs.existsSync(path.join(老.目录, "scoped-sync-migration-baseline.json")), { 步骤: "老板迁移留下备份、删掉起点文件", 哪台: 老板, 期望: "backups/before-scoped-sync-migration.db 在、scoped-sync-migration-baseline.json 没了", 实际: { 备份: fs.existsSync(path.join(老.目录, "backups", "before-scoped-sync-migration.db")), 起点文件: fs.existsSync(path.join(老.目录, "scoped-sync-migration-baseline.json")) } });
      return { 说: `范围迁移 ${(用时 / 1000).toFixed(1)}s 完成，SyncScopedBatch ${数({ 库: 控制库 }, "SELECT COUNT(*) AS n FROM SyncScopedBatch WHERE teamId = ?", 团队id)} 条` };
    }
    const { 用时 } = await 等到({
      步骤: "开通后老板那台把老数据推上云端", 哪台: 老板, 期望: "壳的下一轮推送成功（.team.json 有 lastSyncAt、没有 lastError）",
      取: () => { const c = 读团队文件(老); return { lastSyncAt: c?.lastSyncAt ?? null, lastError: c?.lastError ?? null, last: c?.last ?? null }; },
      满足: (v) => Boolean(v.lastSyncAt) && !v.lastError && (v.last?.推 ?? 0) > 0, 超时: 前台间隔 + 4_000,
    });
    return { 说: `老数据 ${(用时 / 1000).toFixed(1)}s 上云` };
  });

  let 全部进齐;
  await 步("4 位业务员凭邀请码加入", async () => {
    for (const n of 业务员) {
      const r = await 调(台[n], 动作.加入团队, [码]);
      判(r?.ok && r.teamName === `模拟团队${批}`, { 步骤: "加入团队", 哪台: n, 期望: `ok、团队名「模拟团队${批}」`, 实际: r });
    }
    全部进齐 = Date.now();
    const s = await 调(老, 动作.团队状态, []);
    const 谁 = (账号) => 名单.find((n) => 台[n].账号 === 账号) ?? 账号;
    const 成员 = (s?.成员 ?? []).map((m) => `${谁(m.accountId)}:${m.role}`).sort();
    const 应 = 名单.map((n) => `${n}:${n === 老板 ? "owner" : "member"}`).sort();
    判(s?.在团队 && s.我是建的人 && 显示(成员) === 显示(应), { 步骤: "老板那台的团队成员", 哪台: 老板, 期望: 显示(应), 实际: 成员 });
    for (const n of 业务员) {
      const w = await 调(台[n], 动作.团队状态, []);
      判(w?.在团队 && w.我是建的人 === false && (w.成员 ?? []).length === 5, { 步骤: "业务员那台的团队状态", 哪台: n, 期望: "在团队、不是建的人、5 位成员", 实际: w });
    }
  });

  await 步(范围 ? "15 秒内 5 台按范围对齐：老板全队、老库那台只有自己的老客户、其余业务员 0 位，成员账号一致；业务员库里没有越权的行" : "15 秒内 5 台客户数 / 跟进数 / 成员账号一致（含老库那台带进来的老客户）", async () => {
    // 老板的老数据 + 老库那台带进团队的老客户（各 1 条老跟进）
    const 全队客户 = 种子数 + 老客户.length;
    const 全队跟进 = 种子数 * 2 + 老客户.length;
    // 范围同步：老板收全队；老库那台只有自己带进来的老客户；别的业务员此刻一位客户都不该有（公海还是空的）
    const 应 = (n) => (!范围 || n === 老板 ? { 客户: 全队客户, 跟进: 全队跟进 } : n === 老库台 ? { 客户: 老客户.length, 跟进: 老客户.length } : { 客户: 0, 跟进: 0 });
    const 用时 = [];
    for (const n of 名单) {
      const t = 台[n];
      await 等到({
        步骤: 范围 ? "5 台按范围对齐" : "5 台对齐", 哪台: n, 期望: `客户 ${应(n).客户}、跟进 ${应(n).跟进}、团队账号 5 个${范围 ? "；.team.json 范围阶段 ready、同步过、没有 lastError" : ""}`,
        取: () => { const c = 读团队文件(t); return { 客户: 客户数(t), 跟进: 跟进数(t), 账号: 数(t, "SELECT COUNT(*) AS n FROM User WHERE id LIKE 'acct_%'"), ...(范围 ? { 范围: c?.scoped?.stage ?? null, 同步过: Boolean(c?.lastSyncAt), lastError: c?.lastError ?? null } : {}) }; },
        满足: (v) => v.客户 === 应(n).客户 && v.跟进 === 应(n).跟进 && v.账号 === 5 && (!范围 || (v.范围 === "ready" && v.同步过 && !v.lastError)),
        // 从最后一位加入算起 15 秒（前面几台用掉的时间也算在里面）
        超时: Math.max(500, 15_000 - (Date.now() - 全部进齐)), 迟到也报: 20_000,
      });
      用时.push(`${n} ${((Date.now() - 全部进齐) / 1000).toFixed(1)}s`);
    }
    // 角色：每台自己那一行（老板 ADMIN、业务员 SALES）。User.role 不同步，每台按中转名单对
    for (const n of 名单) {
      const t = 台[n];
      const 我 = 查库(t.库, "SELECT role FROM User WHERE id = ?", t.我)[0]?.role;
      判(我 === (n === 老板 ? "ADMIN" : "SALES"), { 步骤: "本机角色", 哪台: n, 期望: n === 老板 ? "ADMIN" : "SALES", 实际: 我 });
      const 别人 = 查库(t.库, "SELECT id, role FROM User WHERE id LIKE 'acct_%' AND id <> ?", t.我).filter((u) => u.role !== (u.id === 老.我 ? "ADMIN" : "SALES"));
      if (别人.length) 观察.push(`${n} 那台库里同事的角色和名单不一致：${别人.map((u) => `${名单.find((m) => 台[m].我 === u.id)}=${u.role}`).join("、")}（User.role 不同步，靠每 5 分钟对一次名单）`);
    }
    // 老库那台的老客户：改身份后归他本人（acct_zhao），每台都是这样；他自己看得到，老板看得到，别的业务员看不到
    // 范围同步：只有老板和他本人那台有，别的业务员库里根本没有
    const 老库 = 台[老库台];
    for (const n of 名单) {
      for (const c of 老客户) {
        const x = 客户(台[n], c.id);
        if (范围 && n !== 老板 && n !== 老库台) {
          判(!x, { 步骤: "范围：老库的老客户不到别的业务员那台", 哪台: `${n} ← ${老库台}`, 期望: `库里没有「${c.名}」`, 实际: x });
          continue;
        }
        判(x?.salesOwnerId === 老库.我, { 步骤: "老库带进来的老客户归老库那台的主人", 哪台: `${n} ← ${老库台}`, 期望: `「${c.名}」负责人 = ${老库.我}`, 实际: x });
      }
    }
    for (const [谁, 该看到] of [[老库台, true], [老板, true], ["wang", false]]) {
      const 列表 = await 客户列表(台[谁]);
      for (const c of 老客户) 判(列表.includes(c.名) === 该看到, { 步骤: "老库的老客户谁看得到", 哪台: 谁, 期望: `列表里${该看到 ? "有" : "没有"}「${c.名}」`, 实际: 该看到 ? "没有" : "看到了" });
    }
    const 老跟进页 = await 页面(老, `/customers/${老客户[0].id}`);
    判(老跟进页.includes(`${老客户[0].名}-老跟进`), { 步骤: "老库客户的老跟进跟着过来", 哪台: 老板, 期望: `客户页里有「${老客户[0].名}-老跟进」`, 实际: "没有" });
    if (范围) return { 说: `${用时.join("、")}；越权检查 ${await 核越权("初次加入")} 行` };
    return { 说: 用时.join("、") };
  });

  const 业务员的 = {};
  await 步("4 位业务员各录 1 位客户 + 1 条跟进 → 老板 10 秒内在页面上看到", async () => {
    const 写完 = {};
    await Promise.all(业务员.map(async (n) => {
      业务员的[n] = await 录一位(台[n], 名(n, "新客户"), 1);
      写完[n] = Date.now();
    }));
    const 用时 = [];
    for (const n of 业务员) {
      const c = 业务员的[n];
      await 等到({ 步骤: "老板看到业务员录的客户", 哪台: `${老板} ← ${n}`, 期望: `客户列表里有「${c.名字}」`, 取: async () => ((await 客户列表(老)).includes(c.名字) ? "有" : "页面上没有"), 满足: (v) => v === "有", 超时: Math.max(500, 10_000 - (Date.now() - 写完[n])), 迟到也报: 20_000 });
      await 等到({ 步骤: "老板看到业务员的跟进", 哪台: `${老板} ← ${n}`, 期望: `客户页里有跟进「${c.跟进[0]}」`, 取: async () => ((await 页面(老, `/customers/${c.id}`)).includes(c.跟进[0]) ? "有" : "页面上没有"), 满足: (v) => v === "有", 超时: Math.max(500, 10_000 - (Date.now() - 写完[n])), 迟到也报: 20_000 });
      用时.push(`${n} ${((Date.now() - 写完[n]) / 1000).toFixed(1)}s`);
      判(客户(老, c.id)?.salesOwnerId === 台[n].我, { 步骤: "业务员录的客户负责人", 哪台: 老板, 期望: `负责人 = ${n}（${台[n].我}）`, 实际: 客户(老, c.id) });
    }
    return { 说: 用时.join("、") };
  });

  await 步(范围 ? "范围：A 的库里根本没有 B 的客户和老板的私客，页面上也没有" : "业务员只看得到自己的 + 公海：A 的页面上没有 B 的客户", async () => {
    // 范围同步：上一步老板已经收到了 4 位业务员的客户（中转上有），各台再跑完一轮，同事的客户也不许进库
    if (范围) await Promise.all(业务员.map((n) => 跑完一轮(台[n])));
    for (const n of 业务员) {
      const t = 台[n];
      // 先等别人的客户真的同步到了这台库里——不然「看不到」可能只是还没到
      for (const m of 业务员) {
        if (m === n) continue;
        if (范围) {
          判(Object.keys(残留(t, 业务员的[m].id)).length === 0, { 步骤: "范围：同事的客户不进本机库", 哪台: `${n} ← ${m}`, 期望: `库里没有 ${m} 的「${业务员的[m].名字}」和它的跟进`, 实际: 残留(t, 业务员的[m].id) });
          continue;
        }
        await 等到({ 步骤: "同事的客户同步到本机库", 哪台: `${n} ← ${m}`, 期望: `库里有 ${m} 的「${业务员的[m].名字}」`, 取: () => 客户(t, 业务员的[m].id), 满足: Boolean, 超时: 15_000, 迟到也报: 20_000 });
      }
      if (范围) 判(!客户(t, 种子[0].id), { 步骤: "范围：老板的私客不进业务员库", 哪台: n, 期望: `库里没有「${种子[0].名字}」`, 实际: 客户(t, 种子[0].id) });
      const 列表 = await 客户列表(t);
      判(列表.includes(业务员的[n].名字), { 步骤: "业务员看得到自己的", 哪台: n, 期望: `列表里有「${业务员的[n].名字}」`, 实际: "没有" });
      for (const m of 业务员) {
        if (m === n) continue;
        判(!列表.includes(业务员的[m].名字), { 步骤: "业务员看不到同事的（客户列表）", 哪台: n, 期望: `列表里没有 ${m} 的「${业务员的[m].名字}」`, 实际: "看到了" });
        const 详情 = await t.会.页面(`/customers/${业务员的[m].id}`);
        判(!详情.text.includes(业务员的[m].名字) && !详情.text.includes(业务员的[m].跟进[0]), { 步骤: "业务员看不到同事的（直接开客户页）", 哪台: n, 期望: `/customers/${业务员的[m].id} 里没有名字和跟进`, 实际: `${详情.状态}，看到了` });
      }
      const 跟进页 = await 页面(t, "/follow-ups");
      for (const m of 业务员) if (m !== n) 判(!跟进页.includes(业务员的[m].跟进[0]), { 步骤: "业务员看不到同事的（跟进页）", 哪台: n, 期望: `跟进页里没有「${业务员的[m].跟进[0]}」`, 实际: "看到了" });
      判(!列表.includes(种子[0].名字), { 步骤: "业务员看不到老板的客户", 哪台: n, 期望: `列表里没有「${种子[0].名字}」`, 实际: "看到了" });
    }
    const 老列表 = await 客户列表(老);
    for (const m of 业务员) 判(老列表.includes(业务员的[m].名字), { 步骤: "老板看全部", 哪台: 老板, 期望: `列表里有「${业务员的[m].名字}」`, 实际: "没有" });
    if (范围) return { 说: `越权检查 ${await 核越权("各自录客户")} 行` };
  });

  const 看得到 = async (t, c) => (await 客户列表(t)).includes(c.名字);
  const 详情看得到 = async (t, c) => (await t.会.页面(`/customers/${c.id}`)).text.includes(c.名字);

  /* ================= 范围同步迁移（TEAM_SIM_SCOPED=migrate）：上面按旧协议跑，从这里起按范围 ================= */
  if (范围模式 === "migrate") await 步("开范围同步：只有云端带 CRM_SCOPED_SYNC=1 重启 → 老板那台先带应急开关 0（不迁移、业务员被告知等老板）→ 不带变量重启、自动迁移 → 业务员清掉失权副本、继续同步", async () => {
    const 控制库 = path.join(云目录, "control.db");
    const 老板前 = { 客户: 客户数(老), 跟进: 跟进数(老) };
    const 业务员前 = Object.fromEntries(业务员.map((n) => [n, 客户数(台[n])]));
    判(业务员.every((n) => 业务员前[n] === 老板前.客户), { 步骤: "迁移前（旧协议）每台都有全队数据", 哪台: 业务员.join(" / "), 期望: `都是 ${老板前.客户} 位`, 实际: 业务员前 });
    开关 = true;
    // 手册顺序：服务端先开 → 老板那台迁移 → 业务员升级。服务端一开，业务员的旧协议就是 409（不判红，列进观察）
    await 关掉(进程.云);
    进程.云 = 起云端();
    await 等起来(进程.云, 云, "云端");
    /*
      应急开关（候选 9）：老板那台带 CRM_SCOPED_SYNC=0 起来——服务端开着也不开始迁移，老板旧协议照常同步；
      业务员不去碰必然 409 的旧接口，回的话要说清楚是在等老板
    */
    老.本机开关 = "0";
    await 关机(老);
    await 开机(老);
    await 跑完一轮(老);
    判(!查库(控制库, "SELECT stage FROM SyncPrivacy WHERE teamId = ?", 团队id)[0] && !读团队文件(老)?.scoped, { 步骤: "老板那台带 CRM_SCOPED_SYNC=0：服务端开着也不开始迁移", 哪台: 老板, 期望: "控制库没有这个团队的 SyncPrivacy、.team.json 没有 scoped", 实际: { 控制库: 查库(控制库, "SELECT stage FROM SyncPrivacy WHERE teamId = ?", 团队id)[0] ?? null, 本机: 读团队文件(老)?.scoped ?? null } });
    const 王说 = await fetch(`${台.wang.会.base}/api/desktop/sync`, { method: "POST", headers: { "x-desktop-token": 台.wang.令牌 }, signal: AbortSignal.timeout(120_000) }).then((x) => x.json());
    判(!王说?.ok && /老板/.test(王说?.error ?? "") && /最新版/.test(王说?.error ?? ""), { 步骤: "老板还没迁移时业务员这一轮的提示", 哪台: "wang", 期望: "没成，话里叫老板打开最新版", 实际: 王说 });
    // 老板那台正常重启（双击打开不带任何环境变量）：只凭服务端开关迁移
    老.本机开关 = undefined;
    const 起 = Date.now();
    await 关机(老);
    await 开机(老);
    await 等到({
      步骤: "老板那台迁移完成", 哪台: 老板, 期望: "控制库 SyncPrivacy = ready；.team.json scoped.stage = ready、没有 lastError；备份在、起点文件删了",
      取: () => { const c = 读团队文件(老); return { 阶段: 查库(控制库, "SELECT stage FROM SyncPrivacy WHERE teamId = ?", 团队id)[0]?.stage ?? null, 本机: c?.scoped?.stage ?? null, lastError: c?.lastError ?? null, 备份: fs.existsSync(path.join(老.目录, "backups", "before-scoped-sync-migration.db")), 起点文件: fs.existsSync(path.join(老.目录, "scoped-sync-migration-baseline.json")) }; },
      满足: (v) => v.阶段 === "ready" && v.本机 === "ready" && !v.lastError && v.备份 && !v.起点文件, 超时: 首轮 + 前台间隔 * 2 + 10_000, 迟到也报: 30_000,
    });
    const 迁完 = Date.now();
    判(客户数(老) === 老板前.客户 && 跟进数(老) === 老板前.跟进, { 步骤: "老板那台迁移前后数据不变", 哪台: 老板, 期望: 老板前, 实际: { 客户: 客户数(老), 跟进: 跟进数(老) } });
    // 业务员升级：重启（同样不带任何环境变量）
    for (const n of 业务员) {
      await 关机(台[n]);
      await 开机(台[n]);
    }
    // 迁移前每人只录了 1 位；老库那台另有 2 位老客户；公海是空的
    const 应 = (n) => 1 + (n === 老库台 ? 老客户.length : 0);
    for (const n of 业务员) {
      const t = 台[n];
      await 等到({
        步骤: "业务员那台换成范围同步、清掉失权副本", 哪台: n, 期望: `.team.json scoped.stage = ready、清理删了 > 0 行、没有 lastError；客户只剩自己的 ${应(n)} 位`,
        取: () => { const c = 读团队文件(t); return { 本机: c?.scoped?.stage ?? null, 清理: c?.scoped?.cleaned ?? null, lastError: c?.lastError ?? null, 客户: 客户数(t) }; },
        满足: (v) => v.本机 === "ready" && (v.清理?.删 ?? 0) > 0 && !v.lastError && v.客户 === 应(n), 超时: 首轮 + 前台间隔 * 2 + 10_000, 迟到也报: 30_000,
      });
      for (const m of 业务员) if (m !== n) 判(!客户(t, 业务员的[m].id), { 步骤: "迁移后同事的客户从本机库里清掉了", 哪台: `${n} ← ${m}`, 期望: `没有「${业务员的[m].名字}」`, 实际: "还在" });
      判(Boolean(客户(t, 业务员的[n].id)) && (await 看得到(t, 业务员的[n])), { 步骤: "迁移后自己的客户还在、看得到", 哪台: n, 期望: `有「${业务员的[n].名字}」`, 实际: "没了" });
    }
    // 越权检查连库文件原始字节一起核：迁移前旧协议时期写进页里的旧内容（空闲页 / 页内空隙 / WAL）清理后整库重建，一个字节都不该剩
    const 越权数 = await 核越权("老板迁移、业务员清理");
    for (const n of 业务员) 判(读团队文件(台[n])?.scoped?.cleaned?.擦净 !== false, { 步骤: "范围：清理之后整库重建、WAL 截断成功", 哪台: n, 期望: "scoped.cleaned.擦净 不是 false", 实际: 读团队文件(台[n])?.scoped?.cleaned });
    const 清理 = 业务员.map((n) => `${n} 删 ${读团队文件(台[n])?.scoped?.cleaned?.删 ?? "?"}`).join("、");
    范围 = true;
    return { 说: `老板迁移 ${((迁完 - 起) / 1000).toFixed(1)}s；${清理}；越权检查 ${越权数} 行` };
  });

  await 步("同时改同一位客户：不同字段两边都留、同字段后改的赢", async () => {
    const w = 台.wang;
    const c = 业务员的.wang;
    const 学校 = `清华-${批}`;
    const 专业 = `计算机-${批}`;
    const [a, b] = await Promise.all([调(w, 动作.改一格, [c.id, "school", 学校]), 调(老, 动作.改一格, [c.id, "major", 专业])]);
    判(a?.ok && b?.ok, { 步骤: "两台同时改不同字段", 哪台: "wang / boss", 期望: "两边都 ok", 实际: { wang: a, boss: b } });
    // 同字段：两台几乎同时写（各自还没收到对方的），时钟晚的赢。来回各一次，免得「总是业务员赢」也蒙混过去
    const 老先 = `老板先改-${批}`, 王后 = `王后改-${批}`;
    const r1 = await 调(老, 动作.改一格, [c.id, "remark", 老先]);
    await 停(50);
    const r2 = await 调(w, 动作.改一格, [c.id, "remark", 王后]);
    const 王先 = `王先改-${批}`, 老后 = `老板后改-${批}`;
    const r3 = await 调(w, 动作.改一格, [c.id, "grade", 王先]);
    await 停(50);
    const r4 = await 调(老, 动作.改一格, [c.id, "grade", 老后]);
    判([r1, r2, r3, r4].every((x) => x?.ok), { 步骤: "两台同时改同一字段", 哪台: "wang / boss", 期望: "四次都 ok", 实际: [r1, r2, r3, r4] });
    const 应 = { school: 学校, major: 专业, remark: 王后, grade: 老后 };
    // 范围同步：这位只在老板和王那台；别的业务员库里本来就没有、也不该因为改了几格就收到
    for (const n of 范围 ? [老板, "wang"] : 名单) {
      await 等到({
        步骤: "同时改之后各台一致", 哪台: `${n} ← wang / boss`, 期望: 显示(应),
        取: () => { const x = 客户(台[n], c.id); return x && { school: x.school, major: x.major, remark: x.remark, grade: x.grade }; },
        满足: (v) => v && 显示(v) === 显示(应), 超时: 15_000, 迟到也报: 20_000,
      });
    }
    if (范围) await 都收不到(["li", "zhao", "sun"], c, "范围：改了几格也不会把别人的客户带到同事那台");
  });

  await 步("老板放一位进公海 → 业务员领 → 别人那边负责人跟着变", async () => {
    const 那位 = 种子[0];
    const li = 台.li;
    const r = await 调(老, 动作.放进公海, [[那位.id]]);
    判(r?.ok && r.updated === 1, { 步骤: "放进公海", 哪台: 老板, 期望: "ok、updated = 1", 实际: r });
    const 放完 = Date.now();
    const { 用时: 到 } = await 等到({ 步骤: "业务员在公海里看到", 哪台: "li ← boss", 期望: `公海页里有「${那位.名字}」`, 取: async () => ((await 客户列表(li, "&pool=1")).includes(那位.名字) ? "有" : "页面上没有"), 满足: (v) => v === "有", 超时: 10_000, 迟到也报: 20_000 });
    await 等到({ 步骤: "别的业务员也在公海里看到", 哪台: "zhao ← boss", 期望: `公海页里有「${那位.名字}」`, 取: async () => ((await 客户列表(台.zhao, "&pool=1")).includes(那位.名字) ? "有" : "页面上没有"), 满足: (v) => v === "有", 超时: 10_000, 迟到也报: 20_000 });
    if (范围) {
      // 范围同步：业务员加入之后老板才放进公海的私客，每位业务员都要收到（含它原来的 2 条跟进），而且在公海里
      for (const n of 业务员) {
        await 等到({ 步骤: "范围：放进公海之后每位业务员库里都有（带跟进）", 哪台: `${n} ← boss`, 期望: `库里有「${那位.名字}」、在公海、跟进 2 条`, 取: () => ({ 有: Boolean(客户(台[n], 那位.id)), 公海: 在公海(台[n], 那位.id), 跟进: 数(台[n], "SELECT COUNT(*) AS n FROM FollowUp WHERE customerId = ?", 那位.id) }), 满足: (v) => v.有 && v.公海 && v.跟进 === 2, 超时: Math.max(500, 15_000 - (Date.now() - 放完)), 迟到也报: 20_000 });
      }
      await 核越权("老板放进公海");
    }
    const k = await 调(li, 动作.领取, [[那位.id]]);
    判(k?.ok && k.updated === 1, { 步骤: "业务员领取", 哪台: "li", 期望: "ok、updated = 1", 实际: k });
    判((await 客户列表(li)).includes(那位.名字), { 步骤: "领完自己列表里有", 哪台: "li", 期望: `列表里有「${那位.名字}」`, 实际: "没有" });
    const 领完 = Date.now();
    // 范围同步：领走之后别的业务员失权，库里连同跟进一起清掉；老板那边负责人变 li
    if (范围) for (const n of 业务员.filter((x) => x !== "li")) await 等没了(台[n], 那位, "范围：被别人领走之后本机库里清掉了");
    for (const n of 范围 ? [老板] : 名单.filter((x) => x !== "li")) {
      await 等到({ 步骤: "领完别人那边负责人变了、出了公海", 哪台: `${n} ← li`, 期望: `负责人 = li（${li.我}）、不在公海`, 取: () => ({ 负责人: 客户(台[n], 那位.id)?.salesOwnerId, 公海: 在公海(台[n], 那位.id) }), 满足: (v) => v.负责人 === li.我 && !v.公海, 超时: 10_000, 迟到也报: 20_000 });
    }
    await 等到({ 步骤: "老板页面上按负责人筛得到", 哪台: 老板, 期望: `?salesOwnerId=${li.我} 里有「${那位.名字}」`, 取: async () => ((await 客户列表(老, `&salesOwnerId=${li.我}`)).includes(那位.名字) ? "有" : "页面上没有"), 满足: (v) => v === "有", 超时: 5_000 });
    判(!(await 客户列表(台.zhao, "&pool=1")).includes(那位.名字), { 步骤: "领走后别的业务员公海里没了", 哪台: "zhao", 期望: `公海页里没有「${那位.名字}」`, 实际: "还在" });
    const 传遍 = ((Date.now() - 领完) / 1000).toFixed(1);
    return { 说: `公海 ${(到 / 1000).toFixed(1)}s 到；领走 ${传遍}s 传遍${范围 ? `；越权检查 ${await 核越权("业务员领取")} 行` : ""}` };
  });

  /* ================= 4.3 有可见性变化的流程：每一步都看「谁看得到、谁看不到」在各台上跟着变 ================= */

  await 步("业务员把自己的客户放进公海 → 同事在公海里看到、领走 → 原来那位就看不到了", async () => {
    const w = 台.wang, z = 台.zhao;
    const c = await 录一位(w, 名("wang", "放公海的"), 1);
    const r = await 调(w, 动作.放进公海, [[c.id]]);
    判(r?.ok && r.updated === 1, { 步骤: "业务员放进公海", 哪台: "wang", 期望: "ok、updated = 1", 实际: r });
    const 放完 = Date.now();
    for (const n of ["li", "zhao", 老板]) {
      await 等到({ 步骤: "别人在公海里看到业务员放的", 哪台: `${n} ← wang`, 期望: `公海页里有「${c.名字}」`, 取: async () => ((await 客户列表(台[n], "&pool=1")).includes(c.名字) ? "有" : "页面上没有"), 满足: (v) => v === "有", 超时: Math.max(500, 10_000 - (Date.now() - 放完)), 迟到也报: 20_000 });
    }
    判((await 客户列表(w, "&pool=1")).includes(c.名字), { 步骤: "放的人自己在公海里也看得到", 哪台: "wang", 期望: `公海页里有「${c.名字}」`, 实际: "没有" });
    const k = await 调(z, 动作.领取, [[c.id]]);
    判(k?.ok && k.updated === 1, { 步骤: "同事领取", 哪台: "zhao", 期望: "ok、updated = 1", 实际: k });
    const 领完 = Date.now();
    await 等到({ 步骤: "领走之后原来那位看不到了（列表和直接开客户页）", 哪台: "wang ← zhao", 期望: `列表、客户页都没有「${c.名字}」`, 取: async () => ({ 列表: await 看得到(w, c), 详情: await 详情看得到(w, c) }), 满足: (v) => !v.列表 && !v.详情, 超时: Math.max(500, 10_000 - (Date.now() - 领完)), 迟到也报: 20_000 });
    判(await 看得到(z, c), { 步骤: "领的人看得到", 哪台: "zhao", 期望: `列表里有「${c.名字}」`, 实际: "没有" });
    await 等到({ 步骤: "老板那边负责人变成领的人", 哪台: `${老板} ← zhao`, 期望: `负责人 = zhao、不在公海`, 取: () => ({ 负责人: 客户(老, c.id)?.salesOwnerId, 公海: 在公海(老, c.id) }), 满足: (v) => v.负责人 === z.我 && !v.公海, 超时: 10_000, 迟到也报: 20_000 });
    if (范围) {
      // 范围同步：在公海时 li、sun 也收到过；被 zhao 领走之后，原来那位和别的业务员库里都清掉
      判(Boolean(客户(z, c.id)), { 步骤: "范围：领的人库里有", 哪台: "zhao", 期望: `有「${c.名字}」`, 实际: "没有" });
      for (const n of ["wang", "li", "sun"]) await 等没了(台[n], c, "范围：同事领走之后本机库里清掉了");
      return { 说: `越权检查 ${await 核越权("业务员放公海、同事领走")} 行` };
    }
  });

  await 步("交接带活：业务员把客户交给同事，没做完的计划跟着过去；交出去的人看不到了", async () => {
    const l = 台.li, z = 台.zhao;
    const c = await 录一位(l, 名("li", "要交接的"), 1);
    const 主题 = `${c.名字}-下周回访`;
    const p = await 调(l, 动作.排计划, [{ customerId: c.id, subject: 主题, plannedAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), method: "电话沟通" }]);
    判(p?.ok, { 步骤: "排计划", 哪台: "li", 期望: "savePlan ok", 实际: p });
    // 详情页单格改负责人（界面上「负责人」那一格），和交接时人点的是同一个动作
    const r = await 调(l, 动作.改一格, [c.id, "salesOwnerId", z.我]);
    判(r?.ok && r.带走?.计划和待办 === 1, { 步骤: "交接", 哪台: "li", 期望: "ok、带走 1 条计划", 实际: r });
    const 交完 = Date.now();
    await 等到({
      步骤: "接手的人那台：客户和计划都过来了、都归他", 哪台: "zhao ← li", 期望: `「${c.名字}」负责人 zhao、计划「${主题}」负责人 zhao，客户页上看得到计划`,
      取: async () => ({ 客户: 客户(z, c.id)?.salesOwnerId === z.我, 计划: 查库(z.库, "SELECT ownerId FROM FollowPlan WHERE customerId = ?", c.id)[0]?.ownerId === z.我, 页: (await 页面(z, "/follow-ups/plans")).includes(主题) }),
      满足: (v) => v.客户 && v.计划 && v.页, 超时: Math.max(500, 10_000 - (Date.now() - 交完)), 迟到也报: 20_000,
    });
    判(await 看得到(z, c), { 步骤: "接手的人列表里有", 哪台: "zhao", 期望: `有「${c.名字}」`, 实际: "没有" });
    判(!(await 看得到(l, c)) && !(await 详情看得到(l, c)), { 步骤: "交出去的人看不到了", 哪台: "li", 期望: `列表、客户页都没有「${c.名字}」`, 实际: "还看得到" });
    判(!(await 页面(l, "/follow-ups/plans")).includes(主题), { 步骤: "交出去的人计划页里也没了", 哪台: "li", 期望: `没有「${主题}」`, 实际: "还在" });
    await 等到({ 步骤: "老板那边负责人和计划跟着变", 哪台: `${老板} ← li`, 期望: "客户、计划都归 zhao", 取: () => ({ 客户: 客户(老, c.id)?.salesOwnerId, 计划: 查库(老.库, "SELECT ownerId FROM FollowPlan WHERE customerId = ?", c.id)[0]?.ownerId }), 满足: (v) => v.客户 === z.我 && v.计划 === z.我, 超时: 10_000, 迟到也报: 20_000 });
    if (范围) {
      // 范围同步：接手的人那台带着跟进；交出去的人库里客户、跟进、计划一行不剩；别的业务员从来没有
      判(数(z, "SELECT COUNT(*) AS n FROM FollowUp WHERE customerId = ?", c.id) === 1, { 步骤: "范围：接手的人那台跟进也过来了", 哪台: "zhao", 期望: "1 条跟进", 实际: 数(z, "SELECT COUNT(*) AS n FROM FollowUp WHERE customerId = ?", c.id) });
      await 等没了(l, c, "范围：交出去之后本机库里清掉了（含计划、跟进）");
      await 都收不到(["wang", "sun"], c, "范围：交接不会把客户带到别的业务员那台");
      return { 说: `越权检查 ${await 核越权("交接")} 行` };
    }
  });

  await 步("老板换负责人：业务员 A 的客户批量转给 B——A 那边没了、B 那边带着跟进出现", async () => {
    const l = 台.li, w = 台.wang;
    const c = 业务员的.li;
    const r = await 调(老, 动作.批量改负责人, [[c.id], w.我]);
    判(r?.ok && r.updated === 1, { 步骤: "老板批量改负责人", 哪台: 老板, 期望: "ok、updated = 1", 实际: r });
    const 改完 = Date.now();
    await 等到({ 步骤: "新负责人看得到，客户页上带着原来的跟进", 哪台: "wang ← boss", 期望: `列表有「${c.名字}」、客户页有「${c.跟进[0]}」`, 取: async () => ({ 列表: await 看得到(w, c), 跟进: (await w.会.页面(`/customers/${c.id}`)).text.includes(c.跟进[0]) }), 满足: (v) => v.列表 && v.跟进, 超时: Math.max(500, 10_000 - (Date.now() - 改完)), 迟到也报: 20_000 });
    await 等到({ 步骤: "原负责人看不到了", 哪台: "li ← boss", 期望: `列表、客户页都没有「${c.名字}」`, 取: async () => ({ 列表: await 看得到(l, c), 详情: await 详情看得到(l, c) }), 满足: (v) => !v.列表 && !v.详情, 超时: 10_000, 迟到也报: 20_000 });
    if (范围) {
      判(数(w, "SELECT COUNT(*) AS n FROM FollowUp WHERE customerId = ?", c.id) === 1, { 步骤: "范围：新负责人库里带着原来的跟进", 哪台: "wang", 期望: "1 条跟进", 实际: 数(w, "SELECT COUNT(*) AS n FROM FollowUp WHERE customerId = ?", c.id) });
      await 等没了(l, c, "范围：老板转走之后原负责人库里清掉了");
      await 都收不到(["zhao", "sun"], c, "范围：批量改负责人不会把客户带到别的业务员那台");
      return { 说: `越权检查 ${await 核越权("老板批量改负责人")} 行` };
    }
  });

  /* ================= 团队互看 + 老板指派公海（2026-10-20，客户需求） ================= */

  await 步("老板把公海里的一位直接分给业务员：他那台按时到、出公海，别的业务员那边没了；撤销回到公海、大家又看得到", async () => {
    const s = 台.sun;
    const c = await 录一位(老, 名("boss", "公海指派"), 1);
    const r0 = await 调(老, 动作.放进公海, [[c.id]]);
    判(r0?.ok && r0.updated === 1, { 步骤: "放进公海", 哪台: 老板, 期望: "ok、updated = 1", 实际: r0 });
    for (const n of 业务员) await 等到({ 步骤: "公海里的到了每位业务员那台", 哪台: `${n} ← boss`, 期望: `库里有「${c.名字}」、在公海`, 取: () => ({ 有: Boolean(客户(台[n], c.id)), 公海: 在公海(台[n], c.id) }), 满足: (v) => v.有 && v.公海, 超时: 15_000, 迟到也报: 20_000 });
    // 业务员调不了（按钮也不摆）
    const 越 = await 调(台.wang, 动作.分配公海, [[c.id], 台.wang.我]);
    判(越?.ok === false, { 步骤: "业务员调分配公海被拒", 哪台: "wang", 期望: "ok = false", 实际: 越 });
    const r = await 调(老, 动作.分配公海, [[c.id], s.我]);
    判(r?.ok && r.updated === 1 && r.给谁?.id === s.我, { 步骤: "老板分配", 哪台: 老板, 期望: `ok、updated = 1、给谁 = sun`, 实际: r });
    const 分完 = Date.now();
    const { 用时 } = await 等到({ 步骤: "分到的人那台：归他、出了公海、带着跟进，列表里看得到", 哪台: "sun ← boss", 期望: `「${c.名字}」负责人 sun、不在公海、跟进 1 条、列表有`, 取: async () => ({ 负责人: 客户(s, c.id)?.salesOwnerId, 公海: 在公海(s, c.id), 跟进: 数(s, "SELECT COUNT(*) AS n FROM FollowUp WHERE customerId = ?", c.id), 列表: (await 客户列表(s)).includes(c.名字) }), 满足: (v) => v.负责人 === s.我 && !v.公海 && v.跟进 === 1 && v.列表, 超时: 10_000, 迟到也报: 20_000 });
    if (范围) for (const n of 业务员.filter((x) => x !== "sun")) await 等没了(台[n], c, "范围：老板分给别人之后本机库里清掉了");
    else for (const n of 业务员.filter((x) => x !== "sun")) await 等到({ 步骤: "别的业务员那边出了公海", 哪台: `${n} ← boss`, 期望: "不在公海", 取: () => 在公海(台[n], c.id), 满足: (v) => !v, 超时: 10_000, 迟到也报: 20_000 });
    const u = await 调(老, 动作.撤销公海, ["分配", r.原负责人, r.带过来, s.我]);
    判(u?.ok && u.updated === 1, { 步骤: "老板撤销分配", 哪台: 老板, 期望: "ok、updated = 1", 实际: u });
    for (const n of 业务员) await 等到({ 步骤: "撤销之后回到公海、每位业务员那台都有", 哪台: `${n} ← boss`, 期望: `库里有「${c.名字}」、在公海、负责人回老板`, 取: () => ({ 有: Boolean(客户(台[n], c.id)), 公海: 在公海(台[n], c.id), 负责人: 客户(台[n], c.id)?.salesOwnerId }), 满足: (v) => v.有 && v.公海 && v.负责人 === 老.我, 超时: 15_000, 迟到也报: 20_000 });
    return { 说: `分到的人 ${(用时 / 1000).toFixed(1)}s 收到（分完到看见 ${((Date.now() - 分完) / 1000).toFixed(1)}s 内撤销也传遍）${范围 ? `；越权检查 ${await 核越权("老板指派公海")} 行` : ""}` };
  });

  if (范围) await 步("团队互看：老板打开 → 业务员 15 秒内收到全队客户和跟进；同事的客户只能加跟进；关掉 → 业务员库里清干净", async () => {
    const w = 台.wang;
    const 私客 = 种子[1];
    const on = await 调(老, 动作.设互看, [true]);
    判(on?.ok && on.on === true, { 步骤: "老板打开互看", 哪台: 老板, 期望: "ok、on = true", 实际: on });
    const 业务员改不了 = await 调(w, 动作.设互看, [false]);
    判(业务员改不了?.ok === false, { 步骤: "业务员改不了开关", 哪台: "wang", 期望: "ok = false", 实际: 业务员改不了 });
    const 开完 = Date.now();
    const 到 = [];
    for (const n of 在队业务员) {
      const { 用时 } = await 等到({
        步骤: "打开后业务员收到全队", 哪台: `${n} ← boss`, 期望: "客户数、跟进数和老板那台一样；.team.json 记着互看",
        取: () => ({ 客户: 客户数(台[n]), 老板客户: 客户数(老), 跟进: 跟进数(台[n]), 老板跟进: 跟进数(老), 互看: 读团队文件(台[n])?.互看 ?? null }),
        满足: (v) => v.客户 === v.老板客户 && v.跟进 === v.老板跟进 && v.互看 === true, 超时: Math.max(500, 15_000 - (Date.now() - 开完)) + 前台间隔, 迟到也报: 30_000,
      });
      到.push(`${n} ${(用时 / 1000).toFixed(1)}s`);
    }
    判((await 客户列表(w)).includes(私客.名字), { 步骤: "业务员列表里看得到老板的私客", 哪台: "wang", 期望: `有「${私客.名字}」`, 实际: "没有" });
    // 同事的客户：能记跟进（老板那边收到），改资料不行
    const 内容 = `${私客.名字}-wang 替老板接的电话`;
    const f = await 调(w, 动作.记跟进, [{ customerId: 私客.id, type: "PHONE", title: "", content: 内容, status: "已完成", occurredAt: new Date().toISOString() }]);
    判(f?.ok, { 步骤: "业务员给老板的客户记跟进", 哪台: "wang", 期望: "ok", 实际: f });
    const 改 = await 调(w, 动作.改一格, [私客.id, "remark", "业务员想改老板的客户"]);
    判(改?.ok === false, { 步骤: "业务员改老板客户的资料被拒", 哪台: "wang", 期望: "ok = false", 实际: 改 });
    await 等到({ 步骤: "老板那边收到业务员记的跟进", 哪台: `${老板} ← wang`, 期望: `有「${内容}」`, 取: () => 数(老, "SELECT COUNT(*) AS n FROM FollowUp WHERE content = ?", 内容), 满足: (v) => v === 1, 超时: 10_000, 迟到也报: 20_000 });
    判(客户(老, 私客.id)?.remark !== "业务员想改老板的客户", { 步骤: "老板那边资料没被改", 哪台: 老板, 期望: "remark 不是业务员写的那句", 实际: 客户(老, 私客.id)?.remark });

    const off = await 调(老, 动作.设互看, [false]);
    判(off?.ok && off.on === false, { 步骤: "老板关掉互看", 哪台: 老板, 期望: "ok、on = false", 实际: off });
    for (const n of 在队业务员) await 等到({ 步骤: "关掉后 .team.json 跟着关", 哪台: n, 期望: "互看 = false", 取: () => 读团队文件(台[n])?.互看 ?? null, 满足: (v) => v === false, 超时: 15_000 + 前台间隔, 迟到也报: 30_000 });
    await 等没了(w, 私客, "关掉后老板的私客（连同业务员自己记的那条跟进）从业务员库里清掉");
    判(!(await 客户列表(w)).includes(私客.名字), { 步骤: "关掉后业务员列表里没了", 哪台: "wang", 期望: `没有「${私客.名字}」`, 实际: "还在" });
    return { 说: `打开后收到全队：${到.join("、")}；关掉后越权检查 ${await 核越权("关掉互看")} 行` };
  });

  if (范围) await 步("业务主管：老板把 li 设成主管 → 他那台收到全队、本机角色 MANAGER、能改老板的客户；改回业务员 → 库里清干净", async () => {
    const l = 台.li;
    const 私客 = 种子[1];
    const 越 = await 调(台.wang, 动作.设角色, [l.账号, "li", "manager"]);
    判(越?.ok === false, { 步骤: "业务员设不了主管", 哪台: "wang", 期望: "ok = false", 实际: 越 });
    const r = await 调(老, 动作.设角色, [l.账号, "li", "manager"]);
    判(r?.ok && r.role === "manager", { 步骤: "老板把 li 设成主管", 哪台: 老板, 期望: "ok、role = manager", 实际: r });
    const 设完 = Date.now();
    const { 用时 } = await 等到({
      步骤: "主管那台收到全队、本机角色跟上", 哪台: "li ← boss", 期望: "客户数、跟进数和老板那台一样；本机 User.role = MANAGER",
      取: () => ({ 客户: 客户数(l), 老板客户: 客户数(老), 跟进: 跟进数(l), 老板跟进: 跟进数(老), 角色: 查库(l.库, "SELECT role FROM User WHERE id = ?", l.我)[0]?.role }),
      满足: (v) => v.客户 === v.老板客户 && v.跟进 === v.老板跟进 && v.角色 === "MANAGER", 超时: 15_000 + 前台间隔, 迟到也报: 30_000,
    });
    判((await 客户列表(l)).includes(私客.名字), { 步骤: "主管列表里看得到老板的私客", 哪台: "li", 期望: `有「${私客.名字}」`, 实际: "没有" });
    const 备注 = `主管改的-${批}`;
    const 改 = await 调(l, 动作.改一格, [私客.id, "remark", 备注]);
    判(改?.ok, { 步骤: "主管改老板客户的资料", 哪台: "li", 期望: "ok", 实际: 改 });
    await 等到({ 步骤: "老板那边收到主管改的", 哪台: `${老板} ← li`, 期望: `remark = ${备注}`, 取: () => 客户(老, 私客.id)?.remark, 满足: (v) => v === 备注, 超时: 10_000, 迟到也报: 20_000 });

    const back = await 调(老, 动作.设角色, [l.账号, "li", "member"]);
    判(back?.ok && back.role === "member", { 步骤: "老板把 li 改回业务员", 哪台: 老板, 期望: "ok、role = member", 实际: back });
    await 等到({ 步骤: "改回后本机角色跟着回", 哪台: "li", 期望: "User.role = SALES", 取: () => 查库(l.库, "SELECT role FROM User WHERE id = ?", l.我)[0]?.role, 满足: (v) => v === "SALES", 超时: 15_000 + 前台间隔, 迟到也报: 30_000 });
    await 等没了(l, 私客, "改回业务员后老板的私客从他库里清掉");
    return { 说: `主管 ${(用时 / 1000).toFixed(1)}s 收到全队（设完到看见 ${((Date.now() - 设完) / 1000).toFixed(1)}s 内改回也清掉）；改回后越权检查 ${await 核越权("改回业务员", ["li"])} 行` };
  });

  /*
    合并疑似重复（2026-10-20，客户「硕诚包装」：老板和业务员各录了一份同号码的）。号码一份带空格、一份不带（号键同一组，
    和老库里「138 0000 1111」对同事录的 13800001111 一样）
  */
  if (范围) await 步("合并疑似重复：老板和王各录了一份同号码的 → 老板合并成一份；王离线时又改了被合并那份、记了跟进，回来后各台都只剩一份、删掉的那份不会被推回来", async () => {
    const w = 台.wang;
    const Y = await 录一位(老, 名("boss", "重复-老板录的"), 2);
    const X = await 录一位(w, 名("wang", "重复-王录的"), 1);
    const 号 = 查库(老.库, "SELECT phone FROM Customer WHERE id = ?", Y.id)[0].phone;
    const 带空格 = `${号.slice(0, 3)} ${号.slice(3, 7)} ${号.slice(7)}`;
    改库(w, "UPDATE Customer SET phone = ?, updatedAt = ? WHERE id = ?", 带空格, Date.now(), X.id);
    // 号码索引按号键存（去空格）：王的库里有这个号是他自己敲的，越权检查的「字节里搜老板私客电话」不把它算进去
    (自己录过的号.wang ??= new Set()).add(号);
    await 等到({ 步骤: "王那份改成同一个号，到了老板那台", 哪台: `${老板} ← wang`, 期望: `「${X.名字}」号码是 ${带空格}`, 取: () => 查库(老.库, "SELECT phone FROM Customer WHERE id = ?", X.id)[0]?.phone, 满足: (v) => v === 带空格, 超时: 15_000 + 前台间隔, 迟到也报: 30_000 });
    const s0 = await 调(老, 动作.团队状态, []);
    const 组 = s0?.重复?.find((g) => g.记录?.some((r) => r.id === X.id));
    判(组 && 组.记录.some((r) => r.id === Y.id) && 组.留 === Y.id, { 步骤: "老板那台疑似重复列出这一对，默认留跟进多的（老板那份）", 哪台: 老板, 期望: `一组里有 X、Y，留 = Y`, 实际: 组 ?? s0?.重复 });
    const 王状态 = await 调(w, 动作.团队状态, []);
    判((王状态?.重复 ?? []).length === 0, { 步骤: "业务员那台没有疑似重复", 哪台: "wang", 期望: "重复 = []", 实际: 王状态?.重复 });
    const 越 = await 调(w, 动作.合并重复, [[{ 留: X.id, 并: Y.id }]]);
    判(越?.ok === false, { 步骤: "业务员调合并被拒", 哪台: "wang", 期望: "ok = false", 实际: 越 });

    // 王关机，老板合并
    await 关机(w);
    const r = await 调(老, 动作.合并重复, [[{ 留: Y.id, 并: X.id }]]);
    判(r?.ok && r.合了 === 1 && !r.没合?.length, { 步骤: "老板合并", 哪台: 老板, 期望: "ok、合了 1 对", 实际: r });
    判(!客户(老, X.id) && 数(老, "SELECT COUNT(*) AS n FROM FollowUp WHERE customerId = ?", Y.id) === 3, { 步骤: "老板那台合并后", 哪台: 老板, 期望: "X 没了、Y 有 3 条跟进", 实际: { X: 客户(老, X.id), 跟进: 数(老, "SELECT COUNT(*) AS n FROM FollowUp WHERE customerId = ?", Y.id) } });
    /*
      先让合并到中转再开王那台（2026-10-21 0.46.25 发版前跑出一次红：老板 8 秒一轮还没推，王开机那一轮先推了，
      中转那时还没有合并记号，离线的改动照收——等于王在合并之前改的，待核对当然是 0）。这一步要测的是「合并先到、离线的被拒」
    */
    await 跑完一轮(老);
    // 离线那台：改 X 的备注、给 X 记一条跟进
    const 现在 = Date.now(), 离线跟进 = `sim_offline_${批}`;
    改库(w, "UPDATE Customer SET remark = ?, updatedAt = ? WHERE id = ?", "王离线时改的", 现在, X.id);
    改库(w, "INSERT INTO FollowUp (id, type, title, content, status, occurredAt, customerId, ownerId, createdAt, updatedAt) VALUES (?, 'PHONE', '', ?, '已完成', ?, ?, ?, ?, ?)", 离线跟进, `${X.名字}-离线记的`, 现在, X.id, w.我, 现在, 现在);
    await 开机(w);
    const 开 = Date.now();
    const { 用时 } = await 等到({
      步骤: "王回来以后：库里 X 没了（离线记的那条跟着清掉，内容进了待核对）", 哪台: "wang", 期望: "X 和它的跟进一行不剩；待核对里有被拒的那几条",
      取: () => ({ 残留: 残留(w, X.id), 待核对: 数(w, "SELECT COUNT(*) AS n FROM _sync_scope_conflict WHERE pk IN (?, ?) AND resolvedAt IS NULL", X.id, 离线跟进) }),
      满足: (v) => Object.keys(v.残留).length === 0 && v.待核对 >= 1, 超时: 首轮 + 前台间隔 * 2 + 4_000, 迟到也报: 45_000,
    });
    await Promise.all([跑完一轮(w), 跑完一轮(老)]);
    for (const n of 名单) {
      判(!客户(台[n], X.id), { 步骤: "X 不会回来", 哪台: n, 期望: "库里没有 X", 实际: 客户(台[n], X.id) });
      判(数(台[n], "SELECT COUNT(*) AS n FROM FollowUp WHERE id = ?", 离线跟进) === 0 || 数(台[n], "SELECT COUNT(*) AS n FROM FollowUp WHERE id = ? AND customerId = ?", 离线跟进, Y.id) === 1, { 步骤: "离线记的那条不会挂在删掉的那份上", 哪台: n, 期望: "没有，或者挂在 Y 上", 实际: 查库(台[n].库, "SELECT customerId FROM FollowUp WHERE id = ?", 离线跟进) });
    }
    判(客户(老, Y.id)?.salesOwnerId === 老.我 && 客户(老, Y.id)?.remark !== "王离线时改的", { 步骤: "老板那份负责人不变、没被离线那台的旧改动盖掉", 哪台: 老板, 期望: "负责人老板、备注不是王离线写的", 实际: 客户(老, Y.id) });
    判(查库(老.库, "SELECT fromOwnerName FROM CustomerMerge WHERE id = ?", X.id)[0]?.fromOwnerName === 查库(老.库, "SELECT name FROM User WHERE id = ?", w.我)[0]?.name, { 步骤: "合并记号记着被合并那份原来的负责人", 哪台: 老板, 期望: "fromOwnerName = 王", 实际: 查库(老.库, "SELECT * FROM CustomerMerge WHERE id = ?", X.id) });
    const 日志 = 查库(老.库, "SELECT summary FROM AuditLog WHERE action = 'merge' AND entityId = ? ORDER BY at DESC LIMIT 1", Y.id)[0]?.summary ?? "";
    判(日志.includes(X.名字), { 步骤: "操作日志记了一笔", 哪台: 老板, 期望: `summary 带「${X.名字}」和原负责人`, 实际: 日志 });
    return { 说: `王回来 ${(用时 / 1000).toFixed(1)}s 清掉被合并那份（开机到核完 ${((Date.now() - 开) / 1000).toFixed(1)}s）；越权检查 ${await 核越权("合并疑似重复")} 行` };
  });

  /* ================= 外贸（2026-10-06 测试分期 E.1）：模版、档案、订单在几台之间 ================= */
  const 预设 = JSON.parse(同步跑(path.join(根, "node_modules/.bin/tsx"), ["-e", "import('./src/lib/business-config.ts').then((m) => console.log(JSON.stringify(m.BUSINESS_PRESETS)))"]));
  const 模版 = (t) => JSON.parse(查库(t.库, "SELECT value FROM Setting WHERE key = 'business'")[0]?.value ?? "{}").template ?? "general";
  const 左栏有订单 = async (t) => (await 页面(t, "/customers?pageSize=1")).includes('href="/orders"');
  const 档案 = (t, id) => 查库(t.库, "SELECT country, whatsapp FROM CustomerExtra WHERE customerId = ?", id);
  const 订单 = (t, no) => 查库(t.库, "SELECT id, contractId, customerId FROM TradeOrder WHERE no = ?", no);
  const 外贸单号 = `PI-SIM-${批}`;
  // 王另录一位来走外贸这一段：最后会交给 li，不能用 业务员的.wang（后面「中转断了」那步还要王改他）
  let 外贸客;

  await 步("老板切外贸 → 其余几台 30 秒内跟上：库里的业务配置是外贸、左栏出现订单", async () => {
    const r = await 调(老, 动作.存业务配置, [预设["外贸出口"]]);
    判(r?.ok, { 步骤: "老板存外贸业务配置", 哪台: 老板, 期望: "{ok:true}", 实际: r });
    判(await 左栏有订单(老), { 步骤: "老板自己那台左栏有订单", 哪台: 老板, 期望: "有 /orders 链接", 实际: "没有" });
    const 存完 = Date.now();
    for (const n of 名单.filter((x) => x !== 老板 && 新版(x))) {
      await 等到({ 步骤: "切外贸传到这台", 哪台: `${n} ← ${老板}`, 期望: "模版 trade、左栏有订单", 取: async () => ({ 模版: 模版(台[n]), 左栏: await 左栏有订单(台[n]) }), 满足: (v) => v.模版 === "trade" && v.左栏, 超时: Math.max(500, 30_000 - (Date.now() - 存完)), 迟到也报: 45_000 });
    }
    return { 说: `${((Date.now() - 存完) / 1000).toFixed(1)}s 传遍` };
  });

  await 步("两台同时填同一位客户的外贸档案（业务员填国家、老板填 WhatsApp）：两格都留，档案还是一行", async () => {
    const w = 台.wang;
    外贸客 = await 录一位(w, 名("wang", "外贸"), 0);
    const c = 外贸客;
    // 先等这位传到老板那台，不然老板改的是一位他库里还没有的客户
    await 等到({ 步骤: "新客户传到老板那台", 哪台: `${老板} ← wang`, 期望: "库里有", 取: () => Boolean(客户(老, c.id)), 满足: Boolean, 超时: 15_000, 迟到也报: 30_000 });
    const [a, b] = await Promise.all([调(w, 动作.改一格, [c.id, "country", "阿联酋"]), 调(老, 动作.改一格, [c.id, "whatsapp", "+971 50 111 2233"])]);
    判(a?.ok && b?.ok, { 步骤: "两台同时填档案", 哪台: "wang / boss", 期望: "两边都 ok", 实际: { wang: a, boss: b } });
    for (const n of 范围 ? [老板, "wang"] : 名单.filter(新版)) {
      await 等到({ 步骤: "档案各台一致", 哪台: `${n} ← wang / boss`, 期望: "一行：阿联酋、+971 50 111 2233", 取: () => 档案(台[n], c.id), 满足: (v) => v.length === 1 && v[0].country === "阿联酋" && v[0].whatsapp === "+971 50 111 2233", 超时: 20_000, 迟到也报: 30_000 });
    }
    if (范围) await 都收不到(["li", "zhao", "sun"], c, "范围：外贸档案不到别的业务员那台");
  });

  await 步("业务员转订单 → 老板订单一览看到；别的业务员看不到", async () => {
    const w = 台.wang;
    const c = 外贸客;
    const k = await 调(w, 动作.登记签约, [{ customerId: c.id, amount: 12000, currency: "USD", signedAt: `$D${new Date().toISOString()}`, remark: null, 订单: { no: 外贸单号, payment: "T/T 30/70" } }]);
    判(k?.ok, { 步骤: "业务员登记订单", 哪台: "wang", 期望: "{ok:true}", 实际: k });
    判((await 页面(w, "/orders")).includes(外贸单号), { 步骤: "业务员自己的订单一览", 哪台: "wang", 期望: `有 ${外贸单号}`, 实际: "没有" });
    const 存完 = Date.now();
    await 等到({ 步骤: "老板订单一览看到", 哪台: `${老板} ← wang`, 期望: `有 ${外贸单号}`, 取: async () => ((await 页面(老, "/orders")).includes(外贸单号) ? "有" : "没有"), 满足: (v) => v === "有", 超时: Math.max(500, 15_000 - (Date.now() - 存完)), 迟到也报: 30_000 });
    // 同事那台库里有了（同步到了）、页面上看不到。范围同步：跑完一轮之后同事库里也没有这张单
    if (范围) {
      await 都收不到(["li", "zhao", "sun"], c, "范围：订单不到别的业务员那台");
      for (const n of ["li", "zhao", "sun"]) 判(订单(台[n], 外贸单号).length === 0, { 步骤: "范围：订单不到别的业务员那台", 哪台: n, 期望: `库里没有 ${外贸单号}`, 实际: 订单(台[n], 外贸单号) });
    } else await 等到({ 步骤: "订单同步到同事那台库里", 哪台: "li ← wang", 期望: "库里有那张单", 取: () => 订单(台.li, 外贸单号).length, 满足: (v) => v === 1, 超时: 15_000, 迟到也报: 30_000 });
    for (const n of ["li", "zhao"]) 判(!(await 页面(台[n], "/orders")).includes(外贸单号), { 步骤: "业务员看不到同事的订单", 哪台: n, 期望: `订单一览里没有 ${外贸单号}`, 实际: "看到了" });
  });

  if (旧台) await 步(`${旧台} 那台一直跑旧版本：照常写、别人收得到；升级到这一版后从头重拉，补齐旧版本收不下的外贸档案和订单，客户不多不少`, async () => {
    const t = 台[旧台];
    const 旧写 = await 录一位(t, 名(旧台, "旧版本写的"), 1);
    await 等到({ 步骤: "旧版本那台写的传到老板那台", 哪台: `${老板} ← ${旧台}（旧版本）`, 期望: `库里有「${旧写.名字}」`, 取: () => Boolean(客户(老, 旧写.id)), 满足: Boolean, 超时: 前台间隔 * 2 + 4_000, 迟到也报: 30_000 });
    const 升级前 = 读团队文件(t);
    观察.push(`混版本：${旧台} 升级前 .team.json —— lastError：${升级前?.lastError ?? "无"}；skipped ${(升级前?.skipped ?? []).length} 批；结构签名 ${升级前?.结构 ? "有" : "没有"}`);
    await 关机(t);
    t.包 = 包;
    t.表 = null;
    t.已升级 = true;
    const 开 = Date.now();
    await 开机(t);
    await 等到({
      步骤: "升级后补齐", 哪台: `${旧台}（刚升级）`, 期望: `外贸档案（阿联酋 / +971…）和 ${外贸单号} 都在、模版是外贸、客户数和老板一样`,
      取: () => ({ 档案: 档案(t, 外贸客.id)[0] ?? null, 单: 订单(t, 外贸单号).length, 模版: 模版(t), 客户: 客户数(t), 老板: 客户数(老) }),
      满足: (v) => v.档案?.country === "阿联酋" && v.档案?.whatsapp === "+971 50 111 2233" && v.单 === 1 && v.模版 === "trade" && v.客户 === v.老板,
      超时: 首轮 + 前台间隔 * 2 + 4_000, 迟到也报: 45_000,
    });
    const 后 = 读团队文件(t);
    判(!后?.lastError, { 步骤: "升级后同步没出错", 哪台: 旧台, 期望: "没有 lastError", 实际: 后?.lastError });
    // 重拉不翻倍：自己旧版本时写的那位在各台都只有一份；各台客户数一致
    for (const n of 名单) {
      判(数(台[n], "SELECT COUNT(*) AS n FROM Customer WHERE name = ?", 旧写.名字) === 1, { 步骤: "重拉之后不出重复", 哪台: n, 期望: `「${旧写.名字}」只有 1 位`, 实际: 数(台[n], "SELECT COUNT(*) AS n FROM Customer WHERE name = ?", 旧写.名字) });
    }
    await 等到({ 步骤: "升级后各台客户数一致", 哪台: 名单.join(" / "), 期望: "一样多", 取: () => 名单.map((n) => 客户数(台[n])), 满足: (v) => new Set(v).size === 1, 超时: 前台间隔 * 2 + 2_000 });
    判(await 左栏有订单(t), { 步骤: "升级后左栏有订单", 哪台: 旧台, 期望: "有 /orders 链接", 实际: "没有" });
    return { 说: `升级后 ${((Date.now() - 开) / 1000).toFixed(1)}s 补齐；升级前 lastError：${升级前?.lastError ? String(升级前.lastError).slice(0, 60) : "无"}` };
  });

  await 步("业务员把带订单的客户交给同事：订单跟着到他那边，交出去的人订单一览里没了", async () => {
    const w = 台.wang, l = 台.li;
    const c = 外贸客;
    const r = await 调(w, 动作.改一格, [c.id, "salesOwnerId", l.我]);
    判(r?.ok, { 步骤: "交接", 哪台: "wang", 期望: "{ok:true}", 实际: r });
    const 交完 = Date.now();
    await 等到({ 步骤: "接手的人订单一览里有", 哪台: "li ← wang", 期望: `有 ${外贸单号}`, 取: async () => ((await 页面(l, "/orders")).includes(外贸单号) ? "有" : "没有"), 满足: (v) => v === "有", 超时: Math.max(500, 15_000 - (Date.now() - 交完)), 迟到也报: 30_000 });
    判(!(await 页面(w, "/orders")).includes(外贸单号), { 步骤: "交出去的人订单一览里没了", 哪台: "wang", 期望: `没有 ${外贸单号}`, 实际: "还在" });
    if (范围) {
      判(订单(l, 外贸单号).length === 1 && 档案(l, c.id).length === 1, { 步骤: "范围：接手的人库里订单、档案都过来了", 哪台: "li", 期望: "订单 1、档案 1", 实际: { 订单: 订单(l, 外贸单号).length, 档案: 档案(l, c.id).length } });
      await 等没了(w, c, "范围：带订单交出去之后本机库里清掉了（含档案、签约、订单）");
      判(订单(w, 外贸单号).length === 0, { 步骤: "范围：交出去的人库里订单没了", 哪台: "wang", 期望: `没有 ${外贸单号}`, 实际: 订单(w, 外贸单号) });
      return { 说: `越权检查 ${await 核越权("带订单交接")} 行` };
    }
  });

  await 步("接手的人删掉这笔订单 → 各台订单和签约都没了", async () => {
    const l = 台.li;
    const [o] = 订单(l, 外贸单号);
    判(o?.contractId, { 步骤: "订单挂着签约", 哪台: "li", 期望: "有 contractId", 实际: o });
    const r = await 调(l, 动作.删签约, [o.contractId, o.customerId, null]);
    判(r?.ok, { 步骤: "删订单", 哪台: "li", 期望: "{ok:true}", 实际: r });
    for (const n of 名单) {
      await 等到({ 步骤: "删订单传到这台", 哪台: `${n} ← li`, 期望: "订单、签约都没了", 取: () => ({ 单: 订单(台[n], 外贸单号).length, 签约: 数(台[n], "SELECT COUNT(*) AS n FROM Contract WHERE id = ?", o.contractId) }), 满足: (v) => v.单 === 0 && v.签约 === 0, 超时: 20_000, 迟到也报: 30_000 });
    }
  });

  await 步("老板切回通用 → 各台跟上、左栏没有订单", async () => {
    const r = await 调(老, 动作.存业务配置, [预设["通用销售"]]);
    判(r?.ok, { 步骤: "老板存通用业务配置", 哪台: 老板, 期望: "{ok:true}", 实际: r });
    const 存完 = Date.now();
    for (const n of 名单.filter((x) => x !== 老板)) {
      await 等到({ 步骤: "切回通用传到这台", 哪台: `${n} ← ${老板}`, 期望: "模版 general、左栏没有订单", 取: async () => ({ 模版: 模版(台[n]), 左栏: await 左栏有订单(台[n]) }), 满足: (v) => v.模版 === "general" && !v.左栏, 超时: Math.max(500, 30_000 - (Date.now() - 存完)), 迟到也报: 45_000 });
    }
  });

  /* ================= 同一账号的第二台电脑（2026-10-14 候选 6 实机：Windows 上领取，Mac 上公海那一行一直不走） ================= */
  await 步("同一账号的第二台电脑（wang2）：领取 / 撤销领取 / 第二台领取 / 交接出去 / 老板分给他 / 放公海 / 删跟进删客户，两台 wang 每一步都一致", async () => {
    const w = 台.wang, l = 台.li;
    // 起第二台：wang 的云端账号在另一台电脑上登录（同一个账号、另一个设备），自动登录、加入团队
    const 端口 = 起始端口 + 名单.length + 1, 目录 = path.join(临时, "desk-wang2");
    const w2 = { 名: "wang2", 包, 端口, 目录, 库: path.join(目录, "crm.db"), 令牌: `sim-wang2-${crypto.randomBytes(12).toString("hex")}`, 密钥: crypto.randomBytes(32).toString("hex"), 会: new 会话("wang2", `http://127.0.0.1:${端口}`), 壳: { 轮: 0, 最近: [], 停: false } };
    台.wang2 = w2;
    const 号 = `wang-${批}@sim.test`, ip = { "x-forwarded-for": `10.77.9.${(Number.parseInt(批, 16) % 200) + 1}` };
    const tk = await 云.json("POST", "/api/account/token", { target: 号, password: 密码, name: "sim-wang2" }, ip);
    判(tk.状态 === 200 && tk.json?.account?.id === w.账号, { 步骤: "第二台登录同一个云端账号", 哪台: "wang2", 期望: `200、账号 ${w.账号}`, 实际: `${tk.状态} ${tk.text}` });
    w2.账号 = w.账号; w2.我 = w.我;
    fs.mkdirSync(目录, { recursive: true });
    fs.writeFileSync(path.join(目录, ".cloud.json"), JSON.stringify({ baseUrl: 云址, token: tk.json.token, accountId: w.账号, name: tk.json.account.name ?? "wang", contact: 号, models: [], loggedAt: new Date().toISOString() }), { mode: 0o600 });
    fs.writeFileSync(path.join(目录, ".owner"), w.账号, { mode: 0o600 });
    进程.wang2 = 起桌面端(w2);
    await 等起来(进程.wang2, w2.会, "wang2");
    void 壳(w2);
    const s = await w2.会.页面(`/api/desktop/session?t=${w2.令牌}`);
    判(s.状态 === 307, { 步骤: "第二台自动登录", 哪台: "wang2", 期望: "307", 实际: `${s.状态} → ${s.跳到}` });
    判((await 调(w2, 动作.选模版, ["general"]))?.ok, { 步骤: "第二台选模版", 哪台: "wang2", 期望: "ok", 实际: "没成" });
    const j = await 调(w2, 动作.加入团队, [码]);
    判(j?.ok, { 步骤: "第二台加入团队", 哪台: "wang2", 期望: "ok", 实际: j });
    const 客户们 = (t) => 查库(t.库, "SELECT id FROM Customer ORDER BY id").map((r) => r.id).join(",");
    await 等到({ 步骤: "第二台拉齐：和第一台客户一样", 哪台: "wang2 ← wang", 期望: "两台 Customer 编号一致", 取: () => ({ 一: 客户们(w), 二: 客户们(w2) }), 满足: (v) => v.一 === v.二 && v.二.length > 0, 超时: 前台间隔 * 3 + 10_000, 迟到也报: 20_000 });
    /** 这位客户在两台 wang 上一样，而且是期望的样子（负责人、在不在公海、跟进条数） */
    const 样子 = (t, id) => ({ 有: Boolean(客户(t, id)), 负责人: 客户(t, id)?.salesOwnerId ?? null, 公海: 在公海(t, id), 跟进: 数(t, "SELECT COUNT(*) AS n FROM FollowUp WHERE customerId = ?", id) });
    const 两台 = async (步骤, id, 期望, 超时 = 前台间隔 * 2 + 6_000) => {
      await 等到({ 步骤, 哪台: "wang / wang2", 期望: 显示(期望), 取: () => ({ wang: 样子(w, id), wang2: 样子(w2, id) }), 满足: (v) => 显示(v.wang) === 显示(v.wang2) && Object.entries(期望).every(([k, x]) => v.wang[k] === x), 超时, 迟到也报: 20_000 });
    };
    const 说 = [];
    const 起 = Date.now();
    // 1. 老板放一位进公海 → 两台都在公海里
    const P = await 录一位(老, 名(老板, "第二台公海"), 1);
    判((await 调(老, 动作.放进公海, [[P.id]]))?.ok, { 步骤: "老板放进公海", 哪台: 老板, 期望: "ok", 实际: "没成" });
    await 两台("放进公海：两台都收到、在公海", P.id, { 有: true, 负责人: 老.我, 公海: true, 跟进: 1 });
    // 2. 第一台领取 → 第二台也出了公海、归 wang（候选 6 的 bug：第二台公海那一行一直不走）
    const k = await 调(w, 动作.领取, [[P.id]]);
    判(k?.ok && k.updated === 1, { 步骤: "第一台领取", 哪台: "wang", 期望: "ok、updated = 1", 实际: k });
    await 两台("第一台领取：第二台也出了公海、归 wang", P.id, { 有: true, 负责人: w.我, 公海: false, 跟进: 1 });
    if (范围) await 等没了(l, P, "范围：wang 领走之后 li 库里清掉了");
    // 3. 撤销领取 → 两台都回到公海、归老板
    const u = await 调(w, 动作.撤销公海, ["领取", k.原负责人, k.带过来]);
    判(u?.ok && u.updated === 1, { 步骤: "撤销领取", 哪台: "wang", 期望: "ok、updated = 1", 实际: u });
    await 两台("撤销领取：两台都回到公海、归老板", P.id, { 有: true, 负责人: 老.我, 公海: true });
    // 4. 第二台领取 → 第一台跟着变
    const k2 = await 调(w2, 动作.领取, [[P.id]]);
    判(k2?.ok && k2.updated === 1, { 步骤: "第二台领取", 哪台: "wang2", 期望: "ok、updated = 1", 实际: k2 });
    await 两台("第二台领取：第一台也出了公海、归 wang", P.id, { 有: true, 负责人: w.我, 公海: false });
    说.push(`领取 / 撤销 / 第二台领取 ${((Date.now() - 起) / 1000).toFixed(1)}s`);
    // 5. 第一台交给 li → 第二台也交出去了（范围：清掉）
    const h = await 调(w, 动作.改一格, [P.id, "salesOwnerId", l.我]);
    判(h?.ok, { 步骤: "第一台交给 li", 哪台: "wang", 期望: "ok", 实际: h });
    await 等到({ 步骤: "交接：li 收到", 哪台: "li ← wang", 期望: "负责人 li、带跟进", 取: () => 样子(l, P.id), 满足: (v) => v.负责人 === l.我 && v.跟进 === 1, 超时: 前台间隔 * 2 + 6_000, 迟到也报: 20_000 });
    if (范围) { await 等没了(w, P, "范围：交出去之后第一台清掉了"); await 等没了(w2, P, "范围：交出去之后第二台也清掉了"); }
    else await 两台("交接：两台 wang 负责人都变成 li", P.id, { 有: true, 负责人: l.我 });
    // 6. 老板把私客分给 wang → 两台都收到（带跟进）
    const B = await 录一位(老, 名(老板, "第二台分给他"), 1);
    判((await 调(老, 动作.批量改负责人, [[B.id], w.我]))?.updated === 1, { 步骤: "老板批量改负责人给 wang", 哪台: 老板, 期望: "updated = 1", 实际: "没成" });
    await 两台("老板分给 wang：两台都收到、带跟进", B.id, { 有: true, 负责人: w.我, 公海: false, 跟进: 1 });
    // 7. 第二台放进公海 → 第一台和 li 都看到在公海
    判((await 调(w2, 动作.放进公海, [[B.id]]))?.updated === 1, { 步骤: "第二台放进公海", 哪台: "wang2", 期望: "updated = 1", 实际: "没成" });
    await 两台("第二台放进公海：第一台也在公海", B.id, { 有: true, 公海: true });
    await 等到({ 步骤: "第二台放进公海：li 在公海里看到", 哪台: "li ← wang2", 期望: "库里有、在公海", 取: () => 样子(l, B.id), 满足: (v) => v.有 && v.公海, 超时: 前台间隔 * 2 + 6_000, 迟到也报: 20_000 });
    // 8. 删除：第一台删跟进 → 第二台跟着删；第二台删客户 → 第一台、老板、li 都没了
    const fid = 查库(w.库, "SELECT id FROM FollowUp WHERE customerId = ?", B.id)[0]?.id;
    判((await 调(w, 动作.删跟进, [fid, B.id]))?.ok, { 步骤: "第一台删跟进", 哪台: "wang", 期望: "ok", 实际: "没成" });
    await 两台("第一台删跟进：第二台也没了", B.id, { 有: true, 跟进: 0 });
    const d = await 调(w2, 动作.删客户, [[B.id]]);
    判(d?.ok && d.deleted === 1, { 步骤: "第二台删客户", 哪台: "wang2", 期望: "ok、deleted = 1", 实际: d });
    for (const t of [w, 老, l]) await 等没了(t, B, "第二台删客户：别的台也没了");
    if (范围) 说.push(`越权检查 ${await 核越权("同一账号第二台", ["wang", "wang2", "li"])} 行`);
    // 收尾：第二台关掉，免得后面几步（中转断开、移除成员）多一台干扰计数
    w2.壳.停 = true;
    await 关掉(进程.wang2);
    return { 说: 说.join("；") };
  });

  await 步("业务员自己退出团队：他那台只留自己的（含老库带进来的），别人那边一条不少、收不到他之后写的", async () => {
    const z = 台.zhao;
    const 前 = Object.fromEntries(名单.filter((n) => n !== "zhao").map((n) => [n, 客户数(台[n])]));
    z.壳.该被移出 = true;
    z.进过团队 = true;
    const r = await 调(z, 动作.退出团队, []);
    判(r?.ok, { 步骤: "业务员退出团队", 哪台: "zhao", 期望: "{ok:true}", 实际: r });
    const 全 = 查库(z.库, "SELECT id, salesOwnerId, channelOwnerId FROM Customer");
    const 别人的 = 全.filter((x) => x.salesOwnerId !== z.我 && x.channelOwnerId !== z.我);
    判(!读团队文件(z) && 别人的.length === 0 && 全.length >= 老客户.length + 2, { 步骤: "退出的那台只留自己的", 哪台: "zhao", 期望: "没有 .team.json；客户全是自己的（老库 2 位 + 领的 + 接手的）", 实际: { 团队文件: Boolean(读团队文件(z)), 共: 全.length, 别人的: 别人的.length } });
    for (const c of 老客户) 判(Boolean(客户(z, c.id)), { 步骤: "老库的老客户还在他那台", 哪台: "zhao", 期望: `有「${c.名}」`, 实际: "没了" });
    const 他新 = await 录一位(z, 名("zhao", "退出后"), 1);
    await 停(前台间隔 + 2_000);
    for (const n of Object.keys(前)) {
      判(客户数(台[n]) === 前[n], { 步骤: "退出的那台的清理没有传出去", 哪台: n, 期望: `客户还是 ${前[n]} 位`, 实际: 客户数(台[n]) });
      判(!客户(台[n], 他新.id), { 步骤: "退出之后他写的不再同步过来", 哪台: `${n} ← zhao`, 期望: `没有「${他新.名字}」`, 实际: "收到了" });
      // 范围同步：他带进来的老客户一直只在老板那台（和他自己那台）；别的业务员从来没有，也不该因为他走了就收到
      for (const c of 老客户) {
        const 该有 = !范围 || n === 老板;
        判(Boolean(客户(台[n], c.id)) === 该有, { 步骤: 该有 ? "他带进来的老客户留在团队里" : "范围：他带进来的老客户不到别的业务员那台", 哪台: n, 期望: `${该有 ? "有" : "没有"}「${c.名}」`, 实际: 该有 ? "没了" : "有" });
      }
    }
    const 状态 = await 调(老, 动作.团队状态, []);
    判(!(状态?.成员 ?? []).some((m) => m.accountId === z.账号), { 步骤: "老板那台的成员名单里没有他了", 哪台: 老板, 期望: "没有 zhao", 实际: (状态?.成员 ?? []).map((m) => m.name) });
    在队业务员.delete("zhao");
    if (范围) {
      // 走的那台只按「本人」核（公海的也不该带走）；留下的业务员照旧按本人 + 公海
      const 走的 = await 核越权("业务员退出团队", ["zhao"], false);
      return { 说: `越权检查 ${走的}、${await 核越权("同事退出团队")} 行` };
    }
  });

  /* ================= 4.5 混合场景 ================= */
  await 步(范围 ? "离线一段时间回来补拉：li 那台关机期间老板录了 3 位私客、分给他 1 位、改了他名下的客户，开机后一轮补齐他该有的、私客一位不来" : "离线一段时间回来补拉：li 那台关机期间老板录了 3 位、改了他名下的客户，开机后一轮补齐", async () => {
    const l = 台.li;
    await 关机(l);
    const 新们 = [];
    for (let i = 1; i <= 3; i++) 新们.push(await 录一位(老, 名(老板, `li关机时${i}`), 1));
    // 范围同步：老板的 3 位私客 li 不该收到；另分给 li 1 位，补拉要有新客户进来（不只是改一格）
    const 分给他 = 范围 ? await 录一位(老, 名(老板, "li关机时分给他的"), 1, l.我) : null;
    const 他的 = 种子[0]; // 前面公海那步 li 领走的
    const 备注 = `li关机时老板补的-${批}`;
    const r = await 调(老, 动作.改一格, [他的.id, "remark", 备注]);
    判(r?.ok, { 步骤: "老板改 li 名下的客户", 哪台: 老板, 期望: "ok", 实际: r });
    await 停(前台间隔); // 关着机过了一轮多
    const 开 = Date.now();
    await 开机(l);
    await 等到({
      步骤: "开机后补齐", 哪台: "li ← boss", 期望: 范围 ? `库里有分给他的「${分给他.名字}」（带跟进）、「${他的.名字}」的备注是新的；他的客户页上看得到新备注` : `库里有关机时录的 3 位、「${他的.名字}」的备注是新的；他的客户页上看得到新备注`,
      取: async () => ({ 新: 新们.filter((x) => 客户(l, x.id)).length, ...(范围 ? { 分给他: Boolean(客户(l, 分给他.id)) && 数(l, "SELECT COUNT(*) AS n FROM FollowUp WHERE customerId = ?", 分给他.id) === 1 } : {}), 备注: 客户(l, 他的.id)?.remark === 备注, 页: (await l.会.页面(`/customers/${他的.id}`)).text.includes(备注) }),
      满足: (v) => (范围 ? v.分给他 : v.新 === 3) && v.备注 && v.页, 超时: 首轮 + 前台间隔 + 2_000, 迟到也报: 20_000,
    });
    if (范围) {
      for (const x of 新们) 判(!客户(l, x.id), { 步骤: "范围：关机期间老板的私客补拉时也不来", 哪台: "li", 期望: `库里没有「${x.名字}」`, 实际: "收到了" });
      判(await 看得到(l, 分给他), { 步骤: "范围：分给他的那位列表里看得到", 哪台: "li", 期望: `列表里有「${分给他.名字}」`, 实际: "没有" });
    }
    for (const x of 新们) 判(!(await 看得到(l, x)), { 步骤: "补拉来的老板的客户业务员照样看不到", 哪台: "li", 期望: `列表里没有「${x.名字}」`, 实际: "看到了" });
    return { 说: `开机 ${((Date.now() - 开) / 1000).toFixed(1)}s 补齐` };
  });

  await 步("中转断了再连上：断着的时候各台照常写，连上之后互相补齐", async () => {
    const 在队 = 名单.filter((n) => n !== "zhao");
    await 关掉(进程.云);
    const 老板写 = await 录一位(老, 名(老板, "中转断时"), 1);
    const 王写 = await 录一位(台.wang, 名("wang", "中转断时"), 1);
    const 王改 = `中转断时王改的-${批}`;
    判((await 调(台.wang, 动作.改一格, [业务员的.wang.id, "remark", 王改]))?.ok, { 步骤: "中转断着时改一格", 哪台: "wang", 期望: "ok（本机照写）", 实际: "失败" });
    // 范围同步：老板的新客户是私客，业务员本来就收不到；另让老板改 sun 名下的一格，看老板 → 业务员这个方向也补得上
    const 老板改 = `中转断时老板改的-${批}`;
    if (范围) 判((await 调(老, 动作.改一格, [业务员的.sun.id, "major", 老板改]))?.ok, { 步骤: "中转断着时老板改业务员的客户", 哪台: 老板, 期望: "ok（本机照写）", 实际: "失败" });
    await 停(前台间隔 + 1_000); // 壳至少碰壁一轮
    for (const n of 在队) 判(!客户(台[n], n === 老板 ? 王写.id : 老板写.id), { 步骤: "中转断着时互相收不到", 哪台: n, 期望: "还没有对方写的", 实际: "收到了（中转没断？）" });
    if (范围) 判(客户(台.sun, 业务员的.sun.id)?.major !== 老板改, { 步骤: "中转断着时互相收不到", 哪台: "sun ← boss", 期望: "还没有老板改的那一格", 实际: "收到了（中转没断？）" });
    const 连上 = Date.now();
    进程.云 = 起云端();
    await 等起来(进程.云, 云, "云端");
    // 范围同步下每台该有的：老板全有；王只有自己写的和改的；sun 只有老板改他那一格；li 什么都不该收到
    const 该有 = (n) => (!范围 || n === 老板 ? { 老板的: true, 王的: true, 改: true, 老板改: 范围 } : { 老板的: false, 王的: n === "wang", 改: n === "wang", 老板改: n === "sun" });
    for (const n of 在队) {
      const 应 = 该有(n);
      await 等到({
        步骤: "中转连上后各台补齐", 哪台: `${n} ← boss / wang`, 期望: 范围 ? `按范围：${显示(应)}` : `有「${老板写.名字}」「${王写.名字}」、「${业务员的.wang.名字}」备注是王改的`,
        取: () => ({ 老板的: Boolean(客户(台[n], 老板写.id)), 王的: Boolean(客户(台[n], 王写.id)), 改: 客户(台[n], 业务员的.wang.id)?.remark === 王改, 老板改: 客户(台[n], 业务员的.sun.id)?.major === 老板改 }),
        // 不该有的那几项「现在没有」不等于「之后也不会有」：等到该有的都到了，再跑完一轮看不该有的
        满足: (v) => Object.entries(应).every(([k, 要]) => !要 || v[k]), 超时: 前台间隔 * 2 + 4_000, 迟到也报: 20_000,
      });
    }
    if (范围) {
      await Promise.all(在队.map((n) => 跑完一轮(台[n])));
      for (const n of 在队) {
        const 应 = 该有(n);
        const 实 = { 老板的: Boolean(客户(台[n], 老板写.id)), 王的: Boolean(客户(台[n], 王写.id)), 改: Boolean(客户(台[n], 业务员的.wang.id)), 老板改: 客户(台[n], 业务员的.sun.id)?.major === 老板改 };
        // 「改」：王名下那位只该在老板和王那台
        判(实.老板的 === 应.老板的 && 实.王的 === 应.王的 && 实.改 === (n === 老板 || n === "wang") && 实.老板改 === 应.老板改, { 步骤: "范围：中转连上后不该有的一位也没来", 哪台: n, 期望: 显示(应), 实际: 实 });
      }
    }
    return { 说: `重连 ${((Date.now() - 连上) / 1000).toFixed(1)}s 补齐` };
  });

  /*
    10-05：同一台电脑上，后台同步正把一大批同事的改动写进库，这时用户点保存。原来多个数据库连接时，
    同步的事务和保存的事务在 SQLite 层面撞锁、互相等死，Linux 上整批「Socket timeout」（Mac 碰巧不发作）。
    现在一个库只开 1 个连接（lib/sqlite-url），两边只排队：保存最多多等一两秒，不报错，同步那批也一条不少
  */
  await 步("同步正在写一大批时，同一台马上建 5 位客户：保存只排队、不报错，那一批也一条不少", async () => {
    const l = 台.li;
    const 大批 = [];
    // 范围同步：老板的私客不会到 li 那台，这一大批改成老板直接分给 li（同样是同步往 li 库里写一大批）
    for (let i = 1; i <= 40; i++) 大批.push(await 录一位(老, 名(老板, `大批${i}`), 2, 范围 ? l.我 : undefined));
    await 停(前台间隔 + 1_000); // 老板那台的壳把这一批推上去
    const 起 = Date.now();
    const [同步, ...存] = await Promise.all([
      fetch(`${l.会.base}/api/desktop/sync`, { method: "POST", headers: { "x-desktop-token": l.令牌 }, signal: AbortSignal.timeout(120_000) })
        .then((r) => r.json())
        .catch((e) => ({ ok: false, error: String(e?.message ?? e) })),
      ...Array.from({ length: 5 }, (_, i) => 调(l, 动作.录客户, [新客户(名("li", `同步时录${i}`), 下一个号(), l.我)])),
    ]);
    const 用时 = Date.now() - 起;
    for (const r of 存) 判(r?.ok && r.id, { 步骤: "同步写库时同一台建客户", 哪台: "li", 期望: "saveCustomer 返回 ok（只排队、不超时）", 实际: r });
    判(用时 < 30_000, { 步骤: "同步写库时同一台建客户", 哪台: "li", 期望: "30 秒内都回来", 实际: `${用时}ms` });
    await 等到({
      步骤: "这一大批到齐", 哪台: "li ← boss", 期望: `${大批.length} 位都在库里`,
      取: () => 大批.filter((x) => 客户(l, x.id)).length,
      满足: (n) => n === 大批.length, 超时: 前台间隔 * 2 + 4_000, 迟到也报: 20_000,
    });
    // li 这 5 位也要传到其余各台才算完：不然下一步开头数的客户数里漏了它们、中途又到，数对不上
    const 新五位 = 存.map((r) => r.id);
    // 范围同步：li 自己的客户只到老板那台
    for (const n of 范围 ? [老板] : 名单.filter((x) => x !== "li" && x !== "zhao")) {
      await 等到({
        步骤: "同步时录的 5 位传遍", 哪台: `${n} ← li`, 期望: "5 位都在库里",
        取: () => 新五位.filter((id) => 客户(台[n], id)).length,
        满足: (k) => k === 新五位.length, 超时: 前台间隔 * 2 + 4_000, 迟到也报: 20_000,
      });
    }
    return { 说: `同步 ${同步?.ok ? "成" : `没成（${String(同步?.error ?? "").slice(0, 40)}，下一轮补）`}、5 位 ${(用时 / 1000).toFixed(1)}s 存完` };
  });

  await 步("老板移除一位 → 其余自动换钥匙继续同步；被移出那台收不到新数据、只留自己的", async () => {
    const 走的 = 台.sun;
    // zhao 前面自己退出了团队，不在「留下」里
    const 留下 = 名单.filter((n) => n !== "sun" && n !== "zhao");
    const 换前 = Object.fromEntries(留下.map((n) => [n, 读团队文件(台[n])?.epoch ?? 0]));
    const 老板客户数前 = 客户数(老);
    const 各台前 = Object.fromEntries(留下.map((n) => [n, 客户数(台[n])]));
    走的.壳.该被移出 = true;
    const r = await 调(老, 动作.移除成员, [走的.账号, "sun"]);
    判(r?.ok, { 步骤: "移除成员", 哪台: 老板, 期望: "{ok:true}", 实际: r });
    // 范围同步：老板这位直接分给 li，换钥匙之后 li 那边也要有新数据进来
    const 老板新 = await 录一位(老, 名(老板, "移除后"), 1, 范围 ? 台.li.我 : undefined);
    const 王新 = await 录一位(台.wang, 名("wang", "移除后"), 1);
    const 写完 = Date.now();
    /** 每台该收到哪几位：旧协议都有；范围 = 老板全有、王只有自己的、li 只有分给他的 */
    const 该收到 = (n) => (!范围 || n === 老板 ? { 老板的: true, 王的: true } : { 老板的: n === "li", 王的: n === "wang" });
    for (const n of 留下) {
      const t = 台[n];
      const 应 = 该收到(n);
      await 等到({
        步骤: "其余各台换了钥匙、收到移除后的新数据", 哪台: `${n} ← boss / wang`, 期望: `钥匙编号 > ${换前[n]}，库里${应.老板的 ? "有" : "没有"}「${老板新.名字}」、${应.王的 ? "有" : "没有"}「${王新.名字}」`,
        取: () => ({ epoch: 读团队文件(t)?.epoch ?? 0, 老板的: Boolean(客户(t, 老板新.id)), 王的: Boolean(客户(t, 王新.id)) }),
        满足: (v) => v.epoch > 换前[n] && (!应.老板的 || v.老板的) && (!应.王的 || v.王的), 超时: 15_000, 迟到也报: 20_000,
      });
    }
    await 等到({
      步骤: "被移出那台自动退出团队、只留自己的客户", 哪台: "sun", 期望: `没有 .team.json；客户全是自己的（${走的.我}）、至少 1 位；本机角色回到 ADMIN`,
      取: () => {
        const 全 = 查库(走的.库, "SELECT id, salesOwnerId, channelOwnerId FROM Customer");
        return { 团队文件: Boolean(读团队文件(走的)), 客户: 全.length, 别人的: 全.filter((c) => c.salesOwnerId !== 走的.我 && c.channelOwnerId !== 走的.我).length, 角色: 查库(走的.库, "SELECT role FROM User WHERE id = ?", 走的.我)[0]?.role };
      },
      满足: (v) => !v.团队文件 && v.客户 >= 1 && v.别人的 === 0 && v.角色 === "ADMIN", 超时: 20_000, 迟到也报: 20_000,
    });
    // 再多等一轮壳：被移出的那台确实一直收不到
    await 停(Math.max(0, 前台间隔 + 2_000 - (Date.now() - 写完)));
    for (const x of [老板新, 王新]) 判(!客户(走的, x.id), { 步骤: "被移出那台收不到新数据", 哪台: "sun", 期望: `库里没有「${x.名字}」`, 实际: "收到了" });
    判(客户(走的, 业务员的.sun.id), { 步骤: "被移出那台自己的客户还在", 哪台: "sun", 期望: `库里有「${业务员的.sun.名字}」`, 实际: "没了" });
    // 他那台删别人客户的那一下不许推出去：其余各台一位都不少
    for (const n of 留下) {
      const 应 = 范围 ? 各台前[n] + Object.values(该收到(n)).filter(Boolean).length : 老板客户数前 + 2;
      判(客户数(台[n]) === 应, { 步骤: "被移出那台的清理没有传出去", 哪台: n, 期望: `客户 ${应} 位`, 实际: 客户数(台[n]) });
      // 范围同步：他录的客户只在老板那台（别的业务员本来就没有）
      const 该有 = !范围 || n === 老板;
      判(Boolean(客户(台[n], 业务员的.sun.id)) === 该有, { 步骤: 该有 ? "被移出的人录的客户留在团队里" : "范围：被移出的人录的客户不到别的业务员那台", 哪台: n, 期望: `库里${该有 ? "还有" : "没有"}「${业务员的.sun.名字}」`, 实际: 该有 ? "没了" : "有" });
      if (范围) for (const [k, x] of [["老板的", 老板新], ["王的", 王新]]) 判(Boolean(客户(台[n], x.id)) === 该收到(n)[k], { 步骤: "范围：移除之后的新数据只到该有的那台", 哪台: n, 期望: `${该收到(n)[k] ? "有" : "没有"}「${x.名字}」`, 实际: 客户(台[n], x.id) ? "有" : "没有" });
    }
    const 状态 = await 调(老, 动作.团队状态, []);
    判((状态?.成员 ?? []).length === 留下.length && !(状态.成员 ?? []).some((m) => m.accountId === 走的.账号), { 步骤: "老板那台的成员名单", 哪台: 老板, 期望: `${留下.length} 位、没有 sun`, 实际: (状态?.成员 ?? []).map((m) => m.name) });
    在队业务员.delete("sun");
    if (范围) {
      const 走 = await 核越权("被老板移出", ["sun"], false);
      const 留 = await 核越权("同事被移出");
      return { 说: `越权检查 ${走}、${留} 行` };
    }
  });
}

/* ---------------- 收尾：不管红绿，按进程号全关、清临时目录 ---------------- */
let 收过 = false;
async function 收尾(红) {
  if (收过) return;
  收过 = true;
  for (const t of Object.values(台)) t.壳.停 = true;
  const 剩 = await 全关();
  if (剩.length) console.error(`!! 有进程没关掉：${剩.map((p) => `${p.名字}(${p.pid})`).join("、")}`);
  // 红了也清：日志尾巴已经打在屏幕上了；要留现场看完整日志和库，用 TEAM_SIM_KEEP=1 再跑一次
  if (留着) console.log(`临时目录留着：${临时}`);
  else {
    fs.rmSync(临时, { recursive: true, force: true });
    if (红) console.error("（临时目录已清；要留现场：TEAM_SIM_KEEP=1 npm run test:team）");
  }
}

function 打印现场(e) {
  console.log("✗");
  console.error(`\n失败：${e instanceof 断言失败 ? e.message : e?.stack ?? e}`);
  const 相关 = e instanceof 断言失败 ? 名单.filter((n) => String(e.哪台 ?? "").includes(n)) : [];
  for (const n of 相关.length ? 相关 : 名单) {
    const t = 台[n];
    console.error(`\n--- ${n}（:${t.端口}）壳最近几轮 ---\n${t.壳.最近.map((x) => 显示(x)).join("\n") || "（还没跑过）"}`);
    console.error(`--- ${n} .team.json lastError：${读团队文件(t)?.lastError ?? "无"}`);
    console.error(`--- ${n} 日志尾巴 ---\n${日志尾巴(path.join(临时, `${n}.log`), 15)}`);
  }
  console.error(`\n--- 云端日志尾巴 ---\n${日志尾巴(path.join(临时, "cloud.log"), 20)}`);
}

for (const s of ["SIGINT", "SIGTERM"]) {
  process.on(s, () => {
    console.error(`\n收到 ${s}，关进程…`);
    void 收尾(true).then(() => process.exit(130));
  });
}

try {
  await 主线();
  const 总 = ((Date.now() - 总起) / 1000).toFixed(0);
  for (const o of 观察) console.log(`观察：${o}`);
  if (没成的轮.length) console.log(`观察：模拟壳有 ${没成的轮.length} 轮同步没成（不判红，下一轮会补上）：\n  ${没成的轮.join("\n  ")}`);
  await 收尾(false);
  console.log(`\n团队版五台实测全绿（${模式名}，${步号} 步，${总}s）`);
} catch (e) {
  打印现场(e);
  // 红了也把已经记下的观察打出来（例如迁移后库文件里的字节残留）
  for (const o of 观察) console.error(`观察：${o}`);
  await 收尾(true);
  process.exit(1);
}
