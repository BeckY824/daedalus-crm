#!/usr/bin/env node
/**
 * 团队版 1b 两部门演示（2026-10-23）：`npm run demo:team:dept`。
 *
 * 一个本机云端（范围同步）+ 5 台桌面端本地服务（和 Electron 里跑的同一个 server-bundle），框架照 run.mjs：
 * 老板建团队、内贸（王一、李二）外贸（赵三、孙四）各两个人，赵三是外贸的销售管理。一路断言：
 *   - 隔离：互看关着，业务员只有自己的；销售管理只收本部门的；互看打开，业务员只多出本部门同事的，另一个部门的库里一行都没有
 *   - 老板列表按部门筛
 *   - 跨部门查重：撞到另一个部门的号，只看到「外贸 · 孙四」和客户名，客户别的资料一概没有，也录不进去
 *   - 邀请进组的边界：客户不能邀请；项目还没同步（项目同步在 1a）时说「还没同步上来」；进组名单接口通
 *
 * 测试号见 dept-demo-seed.json：只在这里临时起的本机云端里注册，跑完连云端一起删。
 * 环境变量：TEAM_SIM_PORT（起始端口，默认 3560）、TEAM_SIM_BUILD（同 run.mjs）、TEAM_SIM_KEEP=1（留临时目录）、
 * DEPT_DEMO_HOLD=1（跑完不关，打印 5 台的自动登录地址给人点着看，Ctrl+C 结束）。
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { 动作 } from "./actions.mjs";
import { 根, 包, 断言失败, 等到, 判, 停, 显示, 起进程, 全关, 日志尾巴, 同步跑, 会话, 读动作表, 调动作, 查库 } from "./lib.mjs";

const 种子 = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "dept-demo-seed.json"), "utf8"));
const 起始端口 = Number(process.env.TEAM_SIM_PORT || 3560);
const 留着 = process.env.TEAM_SIM_KEEP === "1";
const 挂着 = process.env.DEPT_DEMO_HOLD === "1";
const 运营口令 = crypto.randomBytes(12).toString("hex");
const 云密钥 = crypto.randomBytes(32).toString("hex");
const 前台间隔 = 8_000;
const 首轮 = 10_000;

const 名单 = 种子.人.map((p) => p.台);
const 老板 = "boss";
const 临时 = fs.mkdtempSync(path.join(os.tmpdir(), "dept-demo-"));

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
const 没成的轮 = [];

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
  const 源 = Math.max(...["src", "prisma", "migrations", "desktop/server-entry.js", "next.config.ts", "package.json"].map((p) => 最新改动(path.join(根, p))));
  return 源 > fs.statSync(入口).mtimeMs ? "源码比 server-bundle 新" : null;
}

/* ---------------- 进程 ---------------- */
const 云端口 = 起始端口;
const 云址 = `http://127.0.0.1:${云端口}`;
const 云 = new 会话("云端", 云址);
const 云目录 = path.join(临时, "cloud");
const 进程 = {};

const 云端环境 = () => ({
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
  LLM_API_KEY: "",
  LLM_BASE_URL: "",
  LLM_MODEL: "",
  SIGNUP_VERIFY: "",
  SIGNUP_REDIRECT: "",
  CRM_SCOPED_SYNC: "1",
});

const 台 = Object.fromEntries(
  种子.人.map((p, i) => {
    const 端口 = 起始端口 + 1 + i;
    const 目录 = path.join(临时, `desk-${p.台}`);
    return [p.台, { 名: p.台, 人: p, 端口, 目录, 库: path.join(目录, "crm.db"), 令牌: `demo-${p.台}-${crypto.randomBytes(12).toString("hex")}`, 密钥: crypto.randomBytes(32).toString("hex"), 会: new 会话(p.台, `http://127.0.0.1:${端口}`), 壳: { 轮: 0, 最近: [], 停: false } }];
  }),
);
const 叫 = (n) => 台[n].人.名字;

const 起云端 = () => 起进程("云端", process.execPath, [path.join(根, "node_modules/next/dist/bin/next"), "start", "-p", String(云端口), "-H", "127.0.0.1"], { cwd: 根, env: 云端环境(), 日志: path.join(临时, "cloud.log") });
const 起桌面端 = (t) =>
  起进程(t.名, process.execPath, ["entry.js"], {
    cwd: 包,
    日志: path.join(临时, `${t.名}.log`),
    env: { ...process.env, NODE_ENV: "production", PORT: String(t.端口), HOSTNAME: "127.0.0.1", CRM_DATA_DIR: t.目录, DATABASE_URL: `file:${t.库}`, AUTH_SECRET: t.密钥, COOKIE_SECURE: "false", MULTI_TENANT: "", DESKTOP_LOCAL: "1", DESKTOP_TOKEN: t.令牌, CRM_CLOUD_URL: 云址, CRM_SCOPED_SYNC: "" },
  });

function 端口空着(端口) {
  return new Promise((r) => {
    const s = net.createServer();
    s.once("error", () => r(false));
    s.listen(端口, "127.0.0.1", () => s.close(() => r(true)));
  });
}
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
/** 模拟壳：照 desktop/sync.js 的节奏（起来 10 秒后第一轮，之后每 8 秒） */
async function 壳(t) {
  await 停(首轮);
  while (!t.壳.停) {
    const at = new Date().toISOString().slice(11, 19);
    try {
      const res = await fetch(`${t.会.base}/api/desktop/sync`, { method: "POST", headers: { "x-desktop-token": t.令牌 }, signal: AbortSignal.timeout(120_000) });
      const j = await res.json().catch(() => null);
      t.壳.最近.push({ at, r: j ?? res.status });
      if (!j?.ok && !/还没开通/.test(j?.error ?? "")) 没成的轮.push(`${at} ${t.名}：${String(j?.error ?? res.status).replace(/\s+/g, " ").slice(0, 160)}`);
    } catch (e) {
      t.壳.最近.push({ at, 错: String(e.message ?? e) });
      没成的轮.push(`${at} ${t.名}：请求失败 ${String(e.message ?? e).slice(0, 120)}`);
    }
    t.壳.最近 = t.壳.最近.slice(-8);
    t.壳.轮++;
    await 停(前台间隔);
  }
}
/** 写完之后保证这台完整跑过一轮：戳两次（第一次可能复用正在跑的那一轮） */
async function 跑完一轮(t) {
  for (let i = 0; i < 2; i++) await fetch(`${t.会.base}/api/desktop/sync`, { method: "POST", headers: { "x-desktop-token": t.令牌 }, signal: AbortSignal.timeout(120_000) }).catch(() => undefined);
}

/* ---------------- 读数 ---------------- */
const 有 = (t, id) => 查库(t.库, "SELECT COUNT(*) AS n FROM Customer WHERE id = ?", id)[0].n > 0;
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
const 客户列表 = (t, 额外 = "") => 页面(t, `/customers?pageSize=100${额外}`);

let 表;
const 调 = (t, 键, 参数, opt) => 调动作(t.会, 表, 键, 参数, opt);
const 部门 = (t, action, body, 说明 = "演示") => 调(t, 动作.部门动作, [action, body, 说明]);

const 新客户 = (名字, 号, 负责人) => ({ name: 名字, phone: 号, school: null, grade: null, major: null, followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null, remark: null, salesOwnerId: 负责人, channelId: null, referrerCustomerId: null });
let 号段 = 0;
const 下一个号 = () => `139${String(20_000_000 + ++号段 * 7919).slice(-8)}`;
async function 录一位(t, 名字) {
  const 号 = 下一个号();
  const r = await 调(t, 动作.录客户, [新客户(名字, 号, 读团队文件(t) ? t.我 : null)]);
  判(r?.ok && r.id, { 步骤: "录客户", 哪台: t.名, 期望: "saveCustomer 返回 ok 和 id", 实际: r });
  return { id: r.id, 名字, 号 };
}

/* ================================================================== */

async function 主线() {
  const 原因 = 要不要构建();
  if (原因) {
    console.log(`[构建] ${原因}：cd desktop && npm run build:server（含 next build，约 1 分钟）`);
    同步跑("npm", ["run", "build:server"], { cwd: path.join(根, "desktop"), 看得见: true });
  }
  for (let p = 云端口; p <= 云端口 + 名单.length; p++) {
    if (!(await 端口空着(p))) throw new 断言失败({ 步骤: "端口", 期望: `${p} 空着`, 实际: "被占了：换一段，例如 TEAM_SIM_PORT=3660 npm run demo:team:dept" });
  }
  表 = 读动作表(path.join(包, ".next/server/server-reference-manifest.json"));
  for (const k of Object.values(动作)) if (!表.has(k)) throw new 断言失败({ 步骤: "读动作表", 期望: `构建产物里有 ${k}`, 实际: "没有（改过名字？）" });
  console.log(`临时目录 ${临时}；端口 ${云端口}–${云端口 + 名单.length}；范围同步`);

  await 步(`起本机云端（:${云端口}，CRM_SCOPED_SYNC=1）`, async () => {
    fs.mkdirSync(`${云目录}/ws`, { recursive: true });
    fs.writeFileSync(path.join(云目录, "control.db"), "");
    同步跑(process.execPath, [path.join(根, "node_modules/prisma/build/index.js"), "db", "push", "--schema=prisma/control.prisma", "--skip-generate"], { env: 云端环境() });
    进程.云 = 起云端();
    await 等起来(进程.云, 云, "云端");
  });

  await 步("注册 5 个测试号（dept-demo-seed.json）、登录、设名字", async () => {
    for (const [i, n] of 名单.entries()) {
      const t = 台[n];
      const ip = { "x-forwarded-for": `10.78.${i}.1` };
      const s = await 云.json("POST", "/api/account/signup", { target: t.人.账号, password: 种子.密码, agreed: true }, ip);
      判(s.状态 === 200 && s.json?.ok, { 步骤: "注册云端账号", 哪台: n, 期望: "200 {ok:true}", 实际: `${s.状态} ${s.text}` });
      const r = await 云.json("POST", "/api/account/token", { target: t.人.账号, password: 种子.密码, name: `demo-${n}` }, ip);
      判(r.状态 === 200 && r.json?.token && r.json?.account?.id, { 步骤: "登录云端账号", 哪台: n, 期望: "200 带 token 和 account.id", 实际: `${r.状态} ${r.text}` });
      t.账号 = r.json.account.id;
      t.我 = `acct_${t.账号}`;
      const 名 = await 云.json("POST", "/api/account/name", { name: t.人.名字 }, { authorization: `Bearer ${r.json.token}` });
      判(名.状态 === 200, { 步骤: "设账号名字", 哪台: n, 期望: `200（${t.人.名字}）`, 实际: `${名.状态} ${名.text}` });
      fs.mkdirSync(t.目录, { recursive: true });
      fs.writeFileSync(path.join(t.目录, ".cloud.json"), JSON.stringify({ baseUrl: 云址, token: r.json.token, accountId: t.账号, name: t.人.名字, contact: t.人.账号, models: [], loggedAt: new Date().toISOString() }), { mode: 0o600 });
      fs.writeFileSync(path.join(t.目录, ".owner"), t.账号, { mode: 0o600 });
    }
  });

  await 步("起 5 台桌面端 + 模拟壳，自动登录、选「通用」模版", async () => {
    for (const n of 名单) 进程[n] = 起桌面端(台[n]);
    for (const n of 名单) {
      const t = 台[n];
      await 等起来(进程[n], t.会, n);
      void 壳(t);
      const s = await t.会.页面(`/api/desktop/session?t=${t.令牌}`);
      判(s.状态 === 307 && t.会.罐.has("crm_session"), { 步骤: "自动登录", 哪台: n, 期望: "307 且发了 crm_session", 实际: `${s.状态} → ${s.跳到}` });
      const r = await 调(t, 动作.选模版, ["general"]);
      判(r?.ok, { 步骤: "选模版", 哪台: n, 期望: "{ok:true}", 实际: r });
    }
  });

  const 老 = 台[老板];
  const 老板的 = [];
  await 步("老板先录 2 位客户（没分部门，算默认部门内贸）", async () => {
    for (let i = 1; i <= 2; i++) 老板的.push(await 录一位(老, `${叫(老板)}的客户${i}`));
  });

  let 团队id;
  await 步(`老板建「${种子.团队}」、运营台开通、范围同步就绪，4 人凭邀请码加入`, async () => {
    const r = await 调(老, 动作.建团队, [种子.团队]);
    判(r?.ok && /^DT2\./.test(r.邀请码 ?? ""), { 步骤: "建团队", 哪台: 老板, 期望: "ok 且邀请码以 DT2. 开头", 实际: r });
    团队id = r.邀请码.split(".")[1];
    const k = await 调动作(云, 表, 动作.开通团队, [{ token: 运营口令, teamId: 团队id, months: 1, seats: 5, amount: 149.5, note: "dept-demo" }], { 查询: `?token=${运营口令}` });
    判(k?.ok, { 步骤: "运营台开通团队", 哪台: "云端", 期望: "{ok:true}", 实际: k });
    const 控制库 = path.join(云目录, "control.db");
    await 等到({
      步骤: "老板那台完成范围迁移", 哪台: 老板, 期望: "控制库 SyncPrivacy = ready；.team.json scoped.stage = ready、没有 lastError",
      取: () => ({ 阶段: 查库(控制库, "SELECT stage FROM SyncPrivacy WHERE teamId = ?", 团队id)[0]?.stage ?? null, 本机: 读团队文件(老)?.scoped?.stage ?? null, lastError: 读团队文件(老)?.lastError ?? null }),
      满足: (v) => v.阶段 === "ready" && v.本机 === "ready" && !v.lastError, 超时: 前台间隔 * 2 + 6_000, 迟到也报: 20_000,
    });
    for (const n of 名单.filter((x) => x !== 老板)) {
      const j = await 调(台[n], 动作.加入团队, [r.邀请码]);
      判(j?.ok, { 步骤: "加入团队", 哪台: n, 期望: "ok", 实际: j });
    }
    for (const n of 名单.filter((x) => x !== 老板)) {
      await 等到({ 步骤: "加入后范围同步就绪", 哪台: n, 期望: ".team.json scoped.stage = ready、同步过", 取: () => ({ 阶段: 读团队文件(台[n])?.scoped?.stage ?? null, 同步过: Boolean(读团队文件(台[n])?.lastSyncAt) }), 满足: (v) => v.阶段 === "ready" && v.同步过, 超时: 前台间隔 * 2 + 6_000, 迟到也报: 20_000 });
    }
  });

  const 部门id = {};
  await 步("老板建内贸、外贸两个部门，把 4 人分进去，赵三设为外贸的销售管理；业务员建不了部门", async () => {
    for (const 名 of 种子.部门) {
      const r = await 部门(老, "dept-create", { name: 名, parentId: null }, `新建部门「${名}」`);
      判(r?.ok && typeof r.data?.id === "string", { 步骤: "建部门", 哪台: 老板, 期望: `ok、回新部门 id（${名}）`, 实际: r });
      部门id[名] = r.data.id;
    }
    for (const n of 名单.filter((x) => 台[x].人.部门)) {
      const r = await 部门(老, "member", { accountId: 台[n].账号, deptId: 部门id[台[n].人.部门] }, `${叫(n)} 调到 ${台[n].人.部门}`);
      判(r?.ok, { 步骤: "分部门", 哪台: `${老板} → ${n}`, 期望: "ok", 实际: r });
    }
    const m = await 部门(老, "member", { accountId: 台.zhao.账号, bizRole: "sales_mgr" }, `${叫("zhao")} 设为销售管理`);
    判(m?.ok, { 步骤: "设销售管理", 哪台: `${老板} → zhao`, 期望: "ok", 实际: m });
    const 越 = await 部门(台.wang, "dept-create", { name: "私建" }, "越权试一下");
    判(越?.ok === false, { 步骤: "业务员建部门", 哪台: "wang", 期望: "ok:false（云端核权限）", 实际: 越 });
    // 赵三那台对一次名单：本机角色变成主管（真用户是下一轮名单对齐，最多 5 分钟；打开设置 → 团队也会马上对）
    const s = await 调(台.zhao, 动作.团队状态, []);
    const 编 = s?.编制;
    判(编?.部门?.length === 2 && 编?.成员编制?.[台.zhao.账号]?.bizRole === "sales_mgr", { 步骤: "赵三那台拿到编制", 哪台: "zhao", 期望: "2 个部门、自己是 sales_mgr", 实际: 显示(编) });
    const 角色 = 查库(台.zhao.库, "SELECT role FROM User WHERE id = ?", 台.zhao.我)[0]?.role;
    判(角色 === "MANAGER", { 步骤: "销售管理在本机是主管", 哪台: "zhao", 期望: "MANAGER", 实际: 角色 });
    return { 说: `错误回话：「${越.error}」` };
  });

  const 的 = {};
  await 步("4 人各录 1 位客户；老板 15 秒内全看到", async () => {
    for (const n of 名单.filter((x) => x !== 老板)) 的[n] = await 录一位(台[n], `${叫(n)}的客户`);
    const 起 = Date.now();
    await 等到({
      步骤: "老板收到全队", 哪台: 老板, 期望: "客户列表里有 4 位业务员录的",
      取: async () => { const 页 = await 客户列表(老); return Object.values(的).filter((c) => !页.includes(c.名字)).map((c) => c.名字); },
      满足: (v) => v.length === 0, 超时: 15_000, 迟到也报: 20_000,
    });
    return { 说: `${((Date.now() - 起) / 1000).toFixed(1)}s` };
  });

  /** 这台库里、页面上应该有 / 没有哪几位 */
  async function 核(n, 该有, 不该有, 说明) {
    const t = 台[n];
    for (const c of 该有) await 等到({ 步骤: `${说明}：收得到`, 哪台: n, 期望: `库里和客户列表里都有「${c.名字}」`, 取: async () => ({ 库: 有(t, c.id), 页: (await 客户列表(t)).includes(c.名字) }), 满足: (v) => v.库 && v.页, 超时: 前台间隔 * 2 + 6_000, 迟到也报: 20_000 });
    await 跑完一轮(t);
    const 页 = await 客户列表(t);
    for (const c of 不该有) {
      判(!有(t, c.id), { 步骤: `${说明}：库里没有`, 哪台: n, 期望: `本机库里没有「${c.名字}」（跑完一轮之后）`, 实际: "有" });
      判(!页.includes(c.名字), { 步骤: `${说明}：页面上没有`, 哪台: n, 期望: `客户列表里没有「${c.名字}」`, 实际: "看到了" });
    }
  }

  await 步("互看关着：王一只有自己的；赵三（外贸销售管理）收到孙四的，收不到内贸和老板的", async () => {
    await 核("wang", [的.wang], [的.li, 的.zhao, 的.sun, ...老板的], "互看关、销售");
    await 核("zhao", [的.zhao, 的.sun], [的.wang, 的.li, ...老板的], "互看关、外贸销售管理");
  });

  await 步("老板打开互看：内贸的收到内贸同事和老板的，外贸的只收到外贸同事的；另一个部门的一行都不进库", async () => {
    const on = await 调(老, 动作.设互看, [true]);
    判(on?.ok && on.on === true, { 步骤: "老板打开互看", 哪台: 老板, 期望: "ok、on = true", 实际: on });
    const 内贸 = [的.wang, 的.li, ...老板的];
    const 外贸 = [的.zhao, 的.sun];
    await Promise.all([
      核("wang", 内贸, 外贸, "互看开、内贸"),
      核("li", 内贸, 外贸, "互看开、内贸"),
      核("sun", 外贸, 内贸, "互看开、外贸"),
      核("zhao", 外贸, 内贸, "互看开、外贸销售管理"),
    ]);
  });

  await 步("老板的客户列表按部门筛：选外贸只剩赵三、孙四的", async () => {
    const 页 = await 客户列表(老, `&dept=${部门id.外贸}`);
    for (const c of [的.zhao, 的.sun]) 判(页.includes(c.名字), { 步骤: "按部门筛：外贸", 哪台: 老板, 期望: `有「${c.名字}」`, 实际: "没有" });
    for (const c of [的.wang, 的.li, ...老板的]) 判(!页.includes(c.名字), { 步骤: "按部门筛：外贸", 哪台: 老板, 期望: `没有「${c.名字}」`, 实际: "有" });
    const 内 = await 客户列表(老, `&dept=${部门id.内贸}`);
    for (const c of [的.wang, 的.li, ...老板的]) 判(内.includes(c.名字), { 步骤: "按部门筛：内贸（含没分部门的老板）", 哪台: 老板, 期望: `有「${c.名字}」`, 实际: "没有" });
    for (const c of [的.zhao, 的.sun]) 判(!内.includes(c.名字), { 步骤: "按部门筛：内贸", 哪台: 老板, 期望: `没有「${c.名字}」`, 实际: "有" });
  });

  let 查到;
  await 步("跨部门查重：王一录孙四的号，只看到「外贸 · 孙四」和客户名，录不进去", async () => {
    const w = 台.wang;
    const 前 = 查库(w.库, "SELECT COUNT(*) AS n FROM Customer")[0].n;
    // 孙四那台的查重哈希随同步上报：等到云端答得上来
    const { 值 } = await 等到({
      步骤: "跨部门查重", 哪台: "wang ← sun", 期望: `checkDuplicate 回负责人「外贸 · ${叫("sun")}」，没有 id、学校、录入时间`,
      取: () => 调(w, 动作.查重, [的.sun.号]), 满足: (v) => typeof v?.salesOwnerName === "string" && v.salesOwnerName.startsWith("外贸 · "), 超时: 前台间隔 * 2 + 6_000, 迟到也报: 20_000,
    });
    查到 = 值;
    判(值.salesOwnerName === `外贸 · ${叫("sun")}` && 值.id === null && 值.school === null && 值.createdAt === null && (值.name === null || 值.name === 的.sun.名字), { 步骤: "跨部门查重只给概况", 哪台: "wang", 期望: `{id:null, name:「${的.sun.名字}」或 null, school:null, createdAt:null, salesOwnerName:「外贸 · ${叫("sun")}」}`, 实际: 值 });
    const r = await 调(w, 动作.录客户, [新客户(`${叫("wang")}撞号试录`, 的.sun.号, w.我)]);
    判(r?.ok === false && String(r.error ?? "").includes("外贸 · "), { 步骤: "撞了外贸的号录不进去", 哪台: "wang", 期望: "ok:false，错误里写「外贸 · 孙四」", 实际: r });
    判(查库(w.库, "SELECT COUNT(*) AS n FROM Customer")[0].n === 前 && !有(w, 的.sun.id), { 步骤: "撞号之后王一库里没多东西", 哪台: "wang", 期望: `客户还是 ${前} 位、没有孙四的客户`, 实际: 查库(w.库, "SELECT COUNT(*) AS n FROM Customer")[0].n });
    return { 说: `提示：「${r.error}」` };
  });

  await 步("邀请进组的边界：客户不能邀请；项目还没同步上来时说清楚；进组名单接口通（项目同步和界面在 1a）", async () => {
    const 客 = await 部门(老, "invite", { scopeId: `Customer:${的.sun.id}`, accountId: 台.wang.账号, groupRole: "member", label: "演示" }, "邀请进组（客户）");
    判(客?.ok === false, { 步骤: "客户不能邀请进组", 哪台: 老板, 期望: "ok:false", 实际: 客 });
    const 项 = await 部门(老, "invite", { scopeId: "Project:demo-not-synced", accountId: 台.wang.账号, groupRole: "member", label: "演示项目" }, "邀请进组（项目）");
    判(项?.ok === false && /还没同步上来/.test(项.error ?? ""), { 步骤: "项目还没同步上来", 哪台: 老板, 期望: "ok:false，「这个项目还没同步上来，稍后再邀请」", 实际: 项 });
    const 单 = await 部门(台.wang, "invites", {}, "");
    判(单?.ok && Array.isArray(单.data?.待我回) && Array.isArray(单.data?.组员), { 步骤: "进组名单", 哪台: "wang", 期望: "ok，带 待我回 和 组员 两个列表", 实际: 单 });
    return { 说: `客户：「${客.error}」；项目：「${项.error}」` };
  });

  return 查到;
}

/* ---------------- 收尾 ---------------- */
let 收过 = false;
async function 收尾(红) {
  if (收过) return;
  收过 = true;
  for (const t of Object.values(台)) t.壳.停 = true;
  const 剩 = await 全关();
  if (剩.length) console.error(`!! 有进程没关掉：${剩.map((p) => `${p.名字}(${p.pid})`).join("、")}`);
  if (留着) console.log(`临时目录留着：${临时}`);
  else {
    fs.rmSync(临时, { recursive: true, force: true });
    if (红) console.error("（临时目录已清；要留现场：TEAM_SIM_KEEP=1 npm run demo:team:dept）");
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
    void 收尾(!挂着).then(() => process.exit(挂着 ? 0 : 130));
  });
}

try {
  await 主线();
  if (没成的轮.length) console.log(`观察：模拟壳有 ${没成的轮.length} 轮同步没成（不判红）：\n  ${没成的轮.slice(0, 10).join("\n  ")}`);
  console.log(`\n两部门演示全绿（${步号} 步，${((Date.now() - 总起) / 1000).toFixed(0)}s）`);
  if (挂着) {
    console.log("\n服务还开着，浏览器里点下面的地址就是那个人的桌面端（Ctrl+C 结束、清掉临时目录）：");
    for (const n of 名单) console.log(`  ${叫(n).padEnd(4, "　")}（${台[n].人.部门 ?? "没分部门"} · ${台[n].人.角色}）http://127.0.0.1:${台[n].端口}/api/desktop/session?t=${台[n].令牌}`);
    await new Promise(() => {});
  }
  await 收尾(false);
} catch (e) {
  打印现场(e);
  await 收尾(true);
  process.exit(1);
}
