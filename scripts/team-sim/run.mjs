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
 * TEAM_SIM_BUILD（1 = 强制重新 build:server，0 = 不管新旧直接用）、TEAM_SIM_KEEP=1（跑完留着临时目录看日志）。
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

const 起始端口 = Number(process.env.TEAM_SIM_PORT || 3520);
const 种子数 = Math.min(90, Math.max(1, Number(process.env.TEAM_SIM_SEED || 30)));
const 留着 = process.env.TEAM_SIM_KEEP === "1";
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
  };
}

const 台 = Object.fromEntries(
  名单.map((n, i) => {
    const 端口 = 起始端口 + 1 + i;
    const 目录 = path.join(临时, `desk-${n}`);
    return [n, { 名: n, 端口, 目录, 库: path.join(目录, "crm.db"), 令牌: `sim-${n}-${crypto.randomBytes(12).toString("hex")}`, 密钥: crypto.randomBytes(32).toString("hex"), 会: new 会话(n, `http://127.0.0.1:${端口}`), 壳: { 轮: 0, 最近: [], 停: false } }];
  }),
);

function 起桌面端(t) {
  return 起进程(t.名, process.execPath, ["entry.js"], {
    cwd: 包,
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

let 表;
const 调 = (t, 键, 参数, opt) => 调动作(t.会, 表, 键, 参数, opt);

/** 和新建客户表单交的一样。负责人：表单默认填「我」（进团队之后人多了，不填会被拒）；一个人用时不填，服务端取唯一那位 */
function 新客户(名字, 号, 负责人) {
  return { name: 名字, phone: 号, school: null, grade: null, major: null, followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null, remark: null, salesOwnerId: 负责人, channelId: null, referrerCustomerId: null };
}
let 号段 = 0;
const 下一个号 = () => `138${String(10_000_000 + ++号段 * 7919).slice(-8)}`;
const 名 = (谁, 说) => `模拟${批}-${谁}-${说}`;

async function 录一位(t, 名字, 跟进几条 = 1) {
  // 进过团队（哪怕又退了）：库里有同事的账号，负责人要填——表单默认填「我」（T-015）
  const r = await 调(t, 动作.录客户, [新客户(名字, 下一个号(), 读团队文件(t) || t.进过团队 ? t.我 : null)]);
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
  for (let p = 云端口; p <= 云端口 + 名单.length; p++) {
    if (!(await 端口空着(p))) throw new 断言失败({ 步骤: "端口", 期望: `${p} 空着`, 实际: "被占了：换一段，例如 TEAM_SIM_PORT=3620 npm run test:team" });
  }
  表 = 读动作表(path.join(包, ".next/server/server-reference-manifest.json"));
  for (const k of Object.values(动作)) if (!表.has(k)) throw new 断言失败({ 步骤: "读动作表", 期望: `构建产物里有 ${k}`, 实际: "没有（改过名字？）" });
  console.log(`临时目录 ${临时}；端口 ${云端口}–${云端口 + 名单.length}；批次 ${批}`);

  await 步(`起本机云端（托管模式 + 中转，:${云端口}）`, async () => {
    fs.mkdirSync(`${云目录}/ws`, { recursive: true });
    同步跑(process.execPath, [path.join(根, "node_modules/prisma/build/index.js"), "db", "push", "--schema=prisma/control.prisma", "--skip-generate"], { env: 云端环境() });
    // 云端用 next start 跑仓库根目录那份构建（build:server 顺手产出的 .next）：standalone 那份不带 @prisma/client，
    // server-bundle 又裁掉了控制面引擎。会打一句「next start 不配 standalone」的提示，不影响
    进程.云 = 起进程("云端", process.execPath, [path.join(根, "node_modules/next/dist/bin/next"), "start", "-p", String(云端口), "-H", "127.0.0.1"], { cwd: 根, env: 云端环境(), 日志: path.join(临时, "cloud.log") });
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
    const k = await 调动作(云, 表, 动作.开通团队, [{ token: 运营口令, teamId: 团队id, on: true }], { 查询: `?token=${运营口令}` });
    判(k?.ok, { 步骤: "运营台开通团队", 哪台: "云端", 期望: "{ok:true}", 实际: k });
    /*
      真实顺序：建团队 → 运营台人工开通（分钟级）→ 同事加入，加入时老板的老数据早就在云上了。
      这里开通只隔零点几秒，建团队那一下的自动推送撞上「还没开通」，老数据要等老板的壳下一轮（≤ 8 秒）才上去；
      不等这一下，下面「加入后 15 秒对齐」量的就是两跳 8 秒，而不是加入的人拉一次要多久
    */
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

  await 步("15 秒内 5 台客户数 / 跟进数 / 成员账号一致（含老库那台带进来的老客户）", async () => {
    // 老板的老数据 + 老库那台带进团队的老客户（各 1 条老跟进）
    const 应客户 = 种子数 + 老客户.length;
    const 应跟进 = 种子数 * 2 + 老客户.length;
    const 用时 = [];
    for (const n of 名单) {
      const t = 台[n];
      await 等到({
        步骤: "5 台对齐", 哪台: n, 期望: `客户 ${应客户}、跟进 ${应跟进}、团队账号 5 个`,
        取: () => ({ 客户: 客户数(t), 跟进: 跟进数(t), 账号: 数(t, "SELECT COUNT(*) AS n FROM User WHERE id LIKE 'acct_%'") }),
        满足: (v) => v.客户 === 应客户 && v.跟进 === 应跟进 && v.账号 === 5,
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
    const 老库 = 台[老库台];
    for (const n of 名单) {
      for (const c of 老客户) {
        const x = 客户(台[n], c.id);
        判(x?.salesOwnerId === 老库.我, { 步骤: "老库带进来的老客户归老库那台的主人", 哪台: `${n} ← ${老库台}`, 期望: `「${c.名}」负责人 = ${老库.我}`, 实际: x });
      }
    }
    for (const [谁, 该看到] of [[老库台, true], [老板, true], ["wang", false]]) {
      const 列表 = await 客户列表(台[谁]);
      for (const c of 老客户) 判(列表.includes(c.名) === 该看到, { 步骤: "老库的老客户谁看得到", 哪台: 谁, 期望: `列表里${该看到 ? "有" : "没有"}「${c.名}」`, 实际: 该看到 ? "没有" : "看到了" });
    }
    const 老跟进页 = await 页面(老, `/customers/${老客户[0].id}`);
    判(老跟进页.includes(`${老客户[0].名}-老跟进`), { 步骤: "老库客户的老跟进跟着过来", 哪台: 老板, 期望: `客户页里有「${老客户[0].名}-老跟进」`, 实际: "没有" });
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

  await 步("业务员只看得到自己的 + 公海：A 的页面上没有 B 的客户", async () => {
    for (const n of 业务员) {
      const t = 台[n];
      // 先等别人的客户真的同步到了这台库里——不然「看不到」可能只是还没到
      for (const m of 业务员) {
        if (m === n) continue;
        await 等到({ 步骤: "同事的客户同步到本机库", 哪台: `${n} ← ${m}`, 期望: `库里有 ${m} 的「${业务员的[m].名字}」`, 取: () => 客户(t, 业务员的[m].id), 满足: Boolean, 超时: 15_000, 迟到也报: 20_000 });
      }
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
    for (const n of 名单) {
      await 等到({
        步骤: "同时改之后各台一致", 哪台: `${n} ← wang / boss`, 期望: 显示(应),
        取: () => { const x = 客户(台[n], c.id); return x && { school: x.school, major: x.major, remark: x.remark, grade: x.grade }; },
        满足: (v) => v && 显示(v) === 显示(应), 超时: 15_000, 迟到也报: 20_000,
      });
    }
  });

  await 步("老板放一位进公海 → 业务员领 → 别人那边负责人跟着变", async () => {
    const 那位 = 种子[0];
    const li = 台.li;
    const r = await 调(老, 动作.放进公海, [[那位.id]]);
    判(r?.ok && r.updated === 1, { 步骤: "放进公海", 哪台: 老板, 期望: "ok、updated = 1", 实际: r });
    const { 用时: 到 } = await 等到({ 步骤: "业务员在公海里看到", 哪台: "li ← boss", 期望: `公海页里有「${那位.名字}」`, 取: async () => ((await 客户列表(li, "&pool=1")).includes(那位.名字) ? "有" : "页面上没有"), 满足: (v) => v === "有", 超时: 10_000, 迟到也报: 20_000 });
    await 等到({ 步骤: "别的业务员也在公海里看到", 哪台: "zhao ← boss", 期望: `公海页里有「${那位.名字}」`, 取: async () => ((await 客户列表(台.zhao, "&pool=1")).includes(那位.名字) ? "有" : "页面上没有"), 满足: (v) => v === "有", 超时: 10_000, 迟到也报: 20_000 });
    const k = await 调(li, 动作.领取, [[那位.id]]);
    判(k?.ok && k.updated === 1, { 步骤: "业务员领取", 哪台: "li", 期望: "ok、updated = 1", 实际: k });
    判((await 客户列表(li)).includes(那位.名字), { 步骤: "领完自己列表里有", 哪台: "li", 期望: `列表里有「${那位.名字}」`, 实际: "没有" });
    const 领完 = Date.now();
    for (const n of 名单.filter((x) => x !== "li")) {
      await 等到({ 步骤: "领完别人那边负责人变了、出了公海", 哪台: `${n} ← li`, 期望: `负责人 = li（${li.我}）、不在公海`, 取: () => ({ 负责人: 客户(台[n], 那位.id)?.salesOwnerId, 公海: 在公海(台[n], 那位.id) }), 满足: (v) => v.负责人 === li.我 && !v.公海, 超时: 10_000, 迟到也报: 20_000 });
    }
    await 等到({ 步骤: "老板页面上按负责人筛得到", 哪台: 老板, 期望: `?salesOwnerId=${li.我} 里有「${那位.名字}」`, 取: async () => ((await 客户列表(老, `&salesOwnerId=${li.我}`)).includes(那位.名字) ? "有" : "页面上没有"), 满足: (v) => v === "有", 超时: 5_000 });
    判(!(await 客户列表(台.zhao, "&pool=1")).includes(那位.名字), { 步骤: "领走后别的业务员公海里没了", 哪台: "zhao", 期望: `公海页里没有「${那位.名字}」`, 实际: "还在" });
    return { 说: `公海 ${(到 / 1000).toFixed(1)}s 到；领走 ${((Date.now() - 领完) / 1000).toFixed(1)}s 传遍` };
  });

  /* ================= 4.3 有可见性变化的流程：每一步都看「谁看得到、谁看不到」在各台上跟着变 ================= */
  const 看得到 = async (t, c) => (await 客户列表(t)).includes(c.名字);
  const 详情看得到 = async (t, c) => (await t.会.页面(`/customers/${c.id}`)).text.includes(c.名字);

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
  });

  await 步("老板换负责人：业务员 A 的客户批量转给 B——A 那边没了、B 那边带着跟进出现", async () => {
    const l = 台.li, w = 台.wang;
    const c = 业务员的.li;
    const r = await 调(老, 动作.批量改负责人, [[c.id], w.我]);
    判(r?.ok && r.updated === 1, { 步骤: "老板批量改负责人", 哪台: 老板, 期望: "ok、updated = 1", 实际: r });
    const 改完 = Date.now();
    await 等到({ 步骤: "新负责人看得到，客户页上带着原来的跟进", 哪台: "wang ← boss", 期望: `列表有「${c.名字}」、客户页有「${c.跟进[0]}」`, 取: async () => ({ 列表: await 看得到(w, c), 跟进: (await w.会.页面(`/customers/${c.id}`)).text.includes(c.跟进[0]) }), 满足: (v) => v.列表 && v.跟进, 超时: Math.max(500, 10_000 - (Date.now() - 改完)), 迟到也报: 20_000 });
    await 等到({ 步骤: "原负责人看不到了", 哪台: "li ← boss", 期望: `列表、客户页都没有「${c.名字}」`, 取: async () => ({ 列表: await 看得到(l, c), 详情: await 详情看得到(l, c) }), 满足: (v) => !v.列表 && !v.详情, 超时: 10_000, 迟到也报: 20_000 });
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
      for (const c of 老客户) 判(Boolean(客户(台[n], c.id)), { 步骤: "他带进来的老客户留在团队里", 哪台: n, 期望: `有「${c.名}」`, 实际: "没了" });
    }
    const 状态 = await 调(老, 动作.团队状态, []);
    判(!(状态?.成员 ?? []).some((m) => m.accountId === z.账号), { 步骤: "老板那台的成员名单里没有他了", 哪台: 老板, 期望: "没有 zhao", 实际: (状态?.成员 ?? []).map((m) => m.name) });
  });

  /* ================= 4.5 混合场景 ================= */
  await 步("离线一段时间回来补拉：li 那台关机期间老板录了 3 位、改了他名下的客户，开机后一轮补齐", async () => {
    const l = 台.li;
    await 关机(l);
    const 新们 = [];
    for (let i = 1; i <= 3; i++) 新们.push(await 录一位(老, 名(老板, `li关机时${i}`), 1));
    const 他的 = 种子[0]; // 前面公海那步 li 领走的
    const 备注 = `li关机时老板补的-${批}`;
    const r = await 调(老, 动作.改一格, [他的.id, "remark", 备注]);
    判(r?.ok, { 步骤: "老板改 li 名下的客户", 哪台: 老板, 期望: "ok", 实际: r });
    await 停(前台间隔); // 关着机过了一轮多
    const 开 = Date.now();
    await 开机(l);
    await 等到({
      步骤: "开机后补齐", 哪台: "li ← boss", 期望: `库里有关机时录的 3 位、「${他的.名字}」的备注是新的；他的客户页上看得到新备注`,
      取: async () => ({ 新: 新们.filter((x) => 客户(l, x.id)).length, 备注: 客户(l, 他的.id)?.remark === 备注, 页: (await l.会.页面(`/customers/${他的.id}`)).text.includes(备注) }),
      满足: (v) => v.新 === 3 && v.备注 && v.页, 超时: 首轮 + 前台间隔 + 2_000, 迟到也报: 20_000,
    });
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
    await 停(前台间隔 + 1_000); // 壳至少碰壁一轮
    for (const n of 在队) 判(!客户(台[n], n === 老板 ? 王写.id : 老板写.id), { 步骤: "中转断着时互相收不到", 哪台: n, 期望: "还没有对方写的", 实际: "收到了（中转没断？）" });
    const 连上 = Date.now();
    进程.云 = 起进程("云端", process.execPath, [path.join(根, "node_modules/next/dist/bin/next"), "start", "-p", String(云端口), "-H", "127.0.0.1"], { cwd: 根, env: 云端环境(), 日志: path.join(临时, "cloud.log") });
    await 等起来(进程.云, 云, "云端");
    for (const n of 在队) {
      await 等到({
        步骤: "中转连上后各台补齐", 哪台: `${n} ← boss / wang`, 期望: `有「${老板写.名字}」「${王写.名字}」、「${业务员的.wang.名字}」备注是王改的`,
        取: () => ({ 老板的: Boolean(客户(台[n], 老板写.id)), 王的: Boolean(客户(台[n], 王写.id)), 改: 客户(台[n], 业务员的.wang.id)?.remark === 王改 }),
        满足: (v) => v.老板的 && v.王的 && v.改, 超时: 前台间隔 * 2 + 4_000, 迟到也报: 20_000,
      });
    }
    return { 说: `重连 ${((Date.now() - 连上) / 1000).toFixed(1)}s 补齐` };
  });

  await 步("老板移除一位 → 其余自动换钥匙继续同步；被移出那台收不到新数据、只留自己的", async () => {
    const 走的 = 台.sun;
    // zhao 前面自己退出了团队，不在「留下」里
    const 留下 = 名单.filter((n) => n !== "sun" && n !== "zhao");
    const 换前 = Object.fromEntries(留下.map((n) => [n, 读团队文件(台[n])?.epoch ?? 0]));
    const 老板客户数前 = 客户数(老);
    走的.壳.该被移出 = true;
    const r = await 调(老, 动作.移除成员, [走的.账号, "sun"]);
    判(r?.ok, { 步骤: "移除成员", 哪台: 老板, 期望: "{ok:true}", 实际: r });
    const 老板新 = await 录一位(老, 名(老板, "移除后"), 1);
    const 王新 = await 录一位(台.wang, 名("wang", "移除后"), 1);
    const 写完 = Date.now();
    for (const n of 留下) {
      const t = 台[n];
      await 等到({
        步骤: "其余各台换了钥匙、收到移除后的新数据", 哪台: `${n} ← boss / wang`, 期望: `钥匙编号 > ${换前[n]}，库里有「${老板新.名字}」「${王新.名字}」`,
        取: () => ({ epoch: 读团队文件(t)?.epoch ?? 0, 老板的: Boolean(客户(t, 老板新.id)), 王的: Boolean(客户(t, 王新.id)) }),
        满足: (v) => v.epoch > 换前[n] && v.老板的 && v.王的, 超时: 15_000, 迟到也报: 20_000,
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
      判(客户数(台[n]) === 老板客户数前 + 2, { 步骤: "被移出那台的清理没有传出去", 哪台: n, 期望: `客户 ${老板客户数前 + 2} 位`, 实际: 客户数(台[n]) });
      判(Boolean(客户(台[n], 业务员的.sun.id)), { 步骤: "被移出的人录的客户留在团队里", 哪台: n, 期望: `库里还有「${业务员的.sun.名字}」`, 实际: "没了" });
    }
    const 状态 = await 调(老, 动作.团队状态, []);
    判((状态?.成员 ?? []).length === 留下.length && !(状态.成员 ?? []).some((m) => m.accountId === 走的.账号), { 步骤: "老板那台的成员名单", 哪台: 老板, 期望: `${留下.length} 位、没有 sun`, 实际: (状态?.成员 ?? []).map((m) => m.name) });
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
  console.log(`\n团队版五台实测全绿（${总}s）`);
} catch (e) {
  打印现场(e);
  await 收尾(true);
  process.exit(1);
}
