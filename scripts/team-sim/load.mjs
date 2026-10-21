#!/usr/bin/env node
/**
 * 团队版负载实测（2026-10-21，客户 Even 问 30 人走不走得通）：`node scripts/team-sim/load.mjs`。
 *
 * 和 run.mjs（5 台功能断言）分开：这里不断言功能，只量数。一个本机云端（托管模式 + 中转，CRM_SCOPED_SYNC=1，和正式服一样）
 * + N 台桌面端本地服务（server-bundle）+ 每台一个模拟壳（前台每 8 秒戳一次 /api/desktop/sync）。
 * 桌面端和云端之间夹一个计数代理：每秒多少请求、多少字节，按路径分。云端进程组每秒采一次 CPU 时间和内存。
 *
 * 量什么（按阶段）：
 *   1. 老板先有 LOAD_SEED 位老客户（每位 LOAD_FU 条跟进，直接写库，相当于导入完了）→ 建团队 → 开通 → 老板范围迁移把老数据推上中转要多久、中转上存了多大
 *   2. 其余各台凭邀请码加入 → 最后一台加入后多久全员一致（范围就绪、成员名单齐、同步过、没有 lastError）
 *   3. 空闲 LOAD_IDLE 秒：全员前台每 8 秒一轮时，中转每秒请求数、云端 CPU / 内存
 *   4. 每位业务员（第一台）同时录 1 位客户 + 1 条跟进 → 老板那台多久收到（中位 / 最慢）
 *   5. 老板打开「同事之间互相看得到客户」→ 每台业务员拉全队老数据：多久拉齐（LOAD_SHARE_TIMEOUT 秒为止，到时没齐就报进度）
 *
 * 人数：默认一人一台（LOAD_ACCOUNTS = 台数）。LOAD_ACCOUNTS 比台数少时，多出来的电脑是前几位业务员的第二台
 *（10-21 第一轮压测时中转写死 20 人上限只能这么凑，现在人数上限跟席位走）。
 *
 * 环境变量：LOAD_DESKS（电脑台数，默认 30）、LOAD_ACCOUNTS（账号数，默认等于台数）、LOAD_SEED（老客户数，默认 1000）、LOAD_FU（每位几条跟进，默认 3）、
 * LOAD_IDLE（空闲量几秒，默认 60）、LOAD_SHARE（1 = 跑第 5 阶段，默认 1）、LOAD_SHARE_TIMEOUT（默认 600）、LOAD_PORT（起始端口，默认 3800）、
 * LOAD_INTERVAL（壳几毫秒一轮，默认 8000 = 前台）、LOAD_KEEP=1（留临时目录）。结果打印并写到 .bench/负载-<时间>.json（.bench 不进仓库）。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { 动作 } from "./actions.mjs";
import { 根, 包, 等到, 停, 起进程, 全关, 同步跑, 会话, 读动作表, 调动作, 查库, 日志尾巴 } from "./lib.mjs";

const 环境数 = (k, d) => (process.env[k] ? Number(process.env[k]) : d);
const 台数 = 环境数("LOAD_DESKS", 30);
const 账号数 = Math.min(台数, 环境数("LOAD_ACCOUNTS", 台数));
const 种子 = 环境数("LOAD_SEED", 1000);
const 每位跟进 = 环境数("LOAD_FU", 3);
const 空闲秒 = 环境数("LOAD_IDLE", 60);
const 跑互看 = (process.env.LOAD_SHARE ?? "1") === "1";
const 互看超时 = 环境数("LOAD_SHARE_TIMEOUT", 600) * 1000;
const 起始 = 环境数("LOAD_PORT", 3800);
const 留着 = process.env.LOAD_KEEP === "1";
const 前台间隔 = 环境数("LOAD_INTERVAL", 8_000), 首轮 = 10_000;

const 批 = crypto.randomBytes(2).toString("hex");
const 密码 = `Load-${crypto.randomBytes(6).toString("hex")}`;
const 运营口令 = crypto.randomBytes(12).toString("hex");
const 临时 = fs.mkdtempSync(path.join(os.tmpdir(), "team-load-"));
const 代理口 = 起始, 云口 = 起始 + 1;
const 云址 = `http://127.0.0.1:${云口}`, 代理址 = `http://127.0.0.1:${代理口}`;
const 云目录 = path.join(临时, "cloud");
const 云 = new 会话("云端", 云址);
const 进程 = {};
const 结果 = { 时间: new Date().toISOString(), 台数, 账号数, 种子, 每位跟进, 机器: `${os.cpus()[0]?.model} × ${os.cpus().length}，${(os.totalmem() / 2 ** 30).toFixed(0)}G`, 阶段: {} };
const 打 = (s) => console.log(`[${((Date.now() - 总起) / 1000).toFixed(0).padStart(5)}s] ${s}`);
const 总起 = Date.now();

/* ---------------- 计数代理：每秒请求数 / 字节，按路径 ---------------- */
const 计 = { 秒: new Map(), 路径: new Map(), 慢: [] };
const 这秒 = () => Math.floor(Date.now() / 1000);
function 记一笔(路径, 入, 出, 毫秒) {
  const s = 这秒();
  const x = 计.秒.get(s) ?? { 请求: 0, 入: 0, 出: 0 };
  x.请求++; x.入 += 入; x.出 += 出;
  计.秒.set(s, x);
  const k = 路径.split("?")[0];
  const p = 计.路径.get(k) ?? { 次: 0, 毫秒: 0, 最慢: 0 };
  p.次++; p.毫秒 += 毫秒; p.最慢 = Math.max(p.最慢, 毫秒);
  计.路径.set(k, p);
}
const 代理 = http.createServer((req, res) => {
  const 起 = Date.now();
  let 入 = 0, 出 = 0;
  const up = http.request({ host: "127.0.0.1", port: 云口, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.on("data", (c) => { 出 += c.length; });
    r.on("end", () => 记一笔(req.url ?? "", 入, 出, Date.now() - 起));
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); 记一笔(`${req.url}#错`, 入, 0, Date.now() - 起); });
  req.on("data", (c) => { 入 += c.length; });
  req.pipe(up);
});
代理.keepAliveTimeout = 65_000;

/** 从 a 到 b（毫秒时间戳）这段的每秒请求数：平均、峰值；字节 */
function 段内流量(a, b) {
  let 秒数 = 0, 请求 = 0, 峰 = 0, 入 = 0, 出 = 0;
  for (let s = Math.floor(a / 1000); s < Math.floor(b / 1000); s++) {
    const x = 计.秒.get(s);
    秒数++;
    if (!x) continue;
    请求 += x.请求; 入 += x.入; 出 += x.出; 峰 = Math.max(峰, x.请求);
  }
  return { 秒数, 平均每秒请求: +(请求 / Math.max(1, 秒数)).toFixed(1), 峰值每秒请求: 峰, 上行MB: +(入 / 2 ** 20).toFixed(1), 下行MB: +(出 / 2 ** 20).toFixed(1) };
}

/* ---------------- 云端进程组：每秒采 CPU 时间、内存 ---------------- */
const 采样 = [];
const 秒数 = (t) => t.split(":").reduce((a, x) => a * 60 + Number(x), 0);
let 上次 = null;
const 采 = setInterval(() => {
  const pid = 进程.云?.pid;
  if (!pid) return;
  let rss = 0, cpu = 0;
  try {
    for (const 行 of execFileSync("ps", ["-A", "-o", "pgid=,rss=,time="], { encoding: "utf8" }).split("\n")) {
      const [g, r, t] = 行.trim().split(/\s+/);
      if (Number(g) !== pid) continue;
      rss += Number(r) * 1024; cpu += 秒数(t);
    }
  } catch { return; }
  const now = Date.now();
  if (上次) 采样.push({ t: now, rss, 核: (cpu - 上次.cpu) / ((now - 上次.t) / 1000) });
  上次 = { t: now, cpu };
}, 1000);
function 段内云端(a, b) {
  const xs = 采样.filter((x) => x.t >= a && x.t <= b);
  if (!xs.length) return null;
  const 核 = xs.map((x) => x.核).sort((p, q) => p - q);
  return { 平均核: +(核.reduce((s, x) => s + x, 0) / 核.length).toFixed(2), 峰值核: +核[核.length - 1].toFixed(2), P95核: +核[Math.floor(核.length * 0.95)].toFixed(2), 内存峰值MB: Math.round(Math.max(...xs.map((x) => x.rss)) / 2 ** 20) };
}

/* ---------------- 进程 ---------------- */
function 云端环境() {
  return {
    ...process.env, NODE_ENV: "production", MULTI_TENANT: "1",
    CONTROL_DATABASE_URL: `file:${云目录}/control.db`, WORKSPACE_DIR: `${云目录}/ws`, DATABASE_URL: `file:${云目录}/never.db`, SYNC_DIR: `${云目录}/sync`,
    AUTH_SECRET: crypto.randomBytes(32).toString("hex"), COOKIE_SECURE: "false", ADMIN_TOKEN: 运营口令, PORT: String(云口), HOSTNAME: "127.0.0.1",
    LLM_API_KEY: "", LLM_BASE_URL: "", LLM_MODEL: "", SIGNUP_VERIFY: "", SIGNUP_REDIRECT: "", CRM_SCOPED_SYNC: "1",
  };
}
function 起桌面端(t) {
  return 起进程(t.名, process.execPath, ["entry.js"], {
    cwd: 包, 日志: path.join(临时, `${t.名}.log`),
    env: {
      ...process.env, NODE_ENV: "production", PORT: String(t.端口), HOSTNAME: "127.0.0.1", CRM_DATA_DIR: t.目录, DATABASE_URL: `file:${t.库}`,
      AUTH_SECRET: t.密钥, COOKIE_SECURE: "false", MULTI_TENANT: "", DESKTOP_LOCAL: "1", DESKTOP_TOKEN: t.令牌,
      // 走计数代理
      CRM_CLOUD_URL: 代理址, CRM_SCOPED_SYNC: "",
    },
  });
}
async function 等起来(项, 会, 哪台) {
  await 等到({ 步骤: "服务起来", 哪台, 期望: "/api/health 200", 取: async () => { if (项.退了) throw new Error(`进程退了：\n${日志尾巴(项.日志, 15)}`); return 会.json("GET", "/api/health"); }, 满足: (r) => r.状态 === 200, 超时: 120_000, 间隔: 500 });
}
const 没成的轮 = [];
async function 壳(t) {
  await 停(首轮 + Math.random() * 前台间隔); // 真实电脑不会同一秒开机：错开
  while (!t.壳停) {
    const 起 = Date.now();
    try {
      const res = await fetch(`${t.会.base}/api/desktop/sync`, { method: "POST", headers: { "x-desktop-token": t.令牌 }, signal: AbortSignal.timeout(300_000) });
      const j = await res.json().catch(() => null);
      t.轮们.push({ at: 起, 用时: Date.now() - 起, ok: Boolean(j?.ok) });
      if (!j?.ok && !/还没开通|不在团队|没有团队|未加入/.test(j?.error ?? "")) 没成的轮.push(`${new Date(起).toISOString().slice(11, 19)} ${t.名}：${String(j?.error ?? res.status).slice(0, 140)}`);
    } catch (e) {
      t.轮们.push({ at: 起, 用时: Date.now() - 起, ok: false });
      没成的轮.push(`${new Date(起).toISOString().slice(11, 19)} ${t.名}：请求失败 ${String(e.message ?? e).slice(0, 100)}`);
    }
    await 停(前台间隔);
  }
}
function 段内一轮(a, b) {
  const xs = 台们.flatMap((t) => t.轮们.filter((r) => r.at >= a && r.at <= b).map((r) => r.用时)).sort((p, q) => p - q);
  if (!xs.length) return null;
  return { 轮数: xs.length, 中位毫秒: xs[Math.floor(xs.length / 2)], P95毫秒: xs[Math.floor(xs.length * 0.95)], 最慢毫秒: xs[xs.length - 1] };
}

let 表;
const 调 = (t, 键, 参数) => 调动作(t.会, 表, 键, 参数);
const 数 = (库, sql, ...p) => Number(Object.values(查库(库, sql, ...p)[0] ?? { n: 0 })[0]);
const 读团队文件 = (t) => { try { return JSON.parse(fs.readFileSync(path.join(t.目录, ".team.json"), "utf8")); } catch { return null; } };
const 目录大小 = (d) => { try { return Number(execFileSync("du", ["-sk", d], { encoding: "utf8" }).split(/\s+/)[0]) * 1024; } catch { return 0; } };
const MB = (b) => +(b / 2 ** 20).toFixed(1);
function 中转大小() {
  const 控制 = fs.statSync(path.join(云目录, "control.db")).size + (fs.existsSync(path.join(云目录, "control.db-wal")) ? fs.statSync(path.join(云目录, "control.db-wal")).size : 0);
  return { 控制库MB: MB(控制), 密文目录MB: MB(目录大小(path.join(云目录, "sync"))), 范围包条数: 数(path.join(云目录, "control.db"), "SELECT COUNT(*) AS n FROM SyncScopedBatch") };
}
const 分位 = (xs) => { const s = [...xs].sort((a, b) => a - b); return { 中位秒: +(s[Math.floor(s.length / 2)] / 1000).toFixed(1), 最慢秒: +(s[s.length - 1] / 1000).toFixed(1) }; };

/* ---------------- 台：前 账号数 台各一个账号，后面的是前几位业务员的第二台 ---------------- */
const 账号们 = Array.from({ length: 账号数 }, (_, i) => ({ 名: i === 0 ? "boss" : `s${String(i).padStart(2, "0")}`, ip: `10.88.${Math.floor(i / 200)}.${(i % 200) + 1}` }));
const 台们 = Array.from({ length: 台数 }, (_, i) => {
  const 号 = i < 账号数 ? 账号们[i] : 账号们[1 + ((i - 账号数) % (账号数 - 1))];
  const 名 = i < 账号数 ? 号.名 : `${号.名}-2`;
  const 目录 = path.join(临时, `desk-${名}`);
  return { 名, 号, 第二台: i >= 账号数, 端口: 起始 + 10 + i, 目录, 库: path.join(目录, "crm.db"), 令牌: `load-${crypto.randomBytes(12).toString("hex")}`, 密钥: crypto.randomBytes(32).toString("hex"), 会: new 会话(名, `http://127.0.0.1:${起始 + 10 + i}`), 轮们: [], 壳停: false };
});
const 老 = 台们[0];
const 业务员第一台 = 台们.filter((t) => t !== 老 && !t.第二台);

async function 主线() {
  if (!fs.existsSync(path.join(包, "entry.js"))) throw new Error("还没有 desktop/server-bundle：cd desktop && npm run build:server");
  表 = 读动作表(path.join(包, ".next/server/server-reference-manifest.json"));
  打(`临时目录 ${临时}；${台数} 台电脑 / ${账号数} 个账号；老数据 ${种子} 位 × ${每位跟进} 条跟进；端口 ${起始}–${起始 + 10 + 台数}`);

  await new Promise((r) => 代理.listen(代理口, "127.0.0.1", r));
  fs.mkdirSync(`${云目录}/ws`, { recursive: true });
  fs.writeFileSync(path.join(云目录, "control.db"), "");
  同步跑(process.execPath, [path.join(根, "node_modules/prisma/build/index.js"), "db", "push", "--schema=prisma/control.prisma", "--skip-generate"], { env: 云端环境() });
  进程.云 = 起进程("云端", process.execPath, [path.join(根, "node_modules/next/dist/bin/next"), "start", "-p", String(云口), "-H", "127.0.0.1"], { cwd: 根, env: 云端环境(), 日志: path.join(临时, "cloud.log") });
  await 等起来(进程.云, 云, "云端");
  const 云空闲 = Date.now();
  await 停(5_000);
  结果.阶段.云端刚起来 = 段内云端(云空闲, Date.now());
  打(`云端起来了：${JSON.stringify(结果.阶段.云端刚起来)}`);

  // 注册 + 每台拿设备令牌
  for (const a of 账号们) {
    const s = await 云.json("POST", "/api/account/signup", { target: `${a.名}-${批}@load.test`, password: 密码, agreed: true }, { "x-forwarded-for": a.ip });
    if (!(s.状态 === 200 && s.json?.ok)) throw new Error(`注册 ${a.名}：${s.状态} ${s.text}`);
  }
  for (const t of 台们) {
    const r = await 云.json("POST", "/api/account/token", { target: `${t.号.名}-${批}@load.test`, password: 密码, name: `load-${t.名}` }, { "x-forwarded-for": t.号.ip });
    if (!(r.状态 === 200 && r.json?.token)) throw new Error(`登录 ${t.名}：${r.状态} ${r.text}`);
    t.账号 = r.json.account.id;
    fs.mkdirSync(t.目录, { recursive: true });
    fs.writeFileSync(path.join(t.目录, ".cloud.json"), JSON.stringify({ baseUrl: 代理址, token: r.json.token, accountId: t.账号, name: r.json.account.name ?? t.号.名, contact: `${t.号.名}-${批}@load.test`, models: [], loggedAt: new Date().toISOString() }), { mode: 0o600 });
    fs.writeFileSync(path.join(t.目录, ".owner"), t.账号, { mode: 0o600 });
  }
  打(`注册 ${账号数} 个账号、${台数} 台拿到设备令牌`);

  // 起桌面端：一次 6 台，别把本机一下子压死
  for (let i = 0; i < 台们.length; i += 6) {
    const 这批 = 台们.slice(i, i + 6);
    for (const t of 这批) 进程[t.名] = 起桌面端(t);
    for (const t of 这批) await 等起来(进程[t.名], t.会, t.名);
  }
  for (const t of 台们) {
    const s = await t.会.页面(`/api/desktop/session?t=${t.令牌}`);
    if (s.状态 !== 307) throw new Error(`${t.名} 自动登录：${s.状态}`);
    const r = await 调(t, 动作.选模版, ["general"]);
    if (!r?.ok) throw new Error(`${t.名} 选模版：${JSON.stringify(r)}`);
    void 壳(t);
  }
  打(`${台数} 台桌面端起来、登录、选好模版，壳开始每 8 秒一轮`);

  // 1. 老数据：直接写老板的库（相当于 Excel 导入完了）
  {
    const 管理员 = 查库(老.库, "SELECT id FROM User WHERE role = 'ADMIN' ORDER BY createdAt LIMIT 1")[0]?.id;
    if (!管理员) throw new Error("老板那台找不到管理员账号");
    const 起 = Date.now();
    const db = new DatabaseSync(老.库);
    try {
      db.exec("PRAGMA busy_timeout = 10000");
      db.exec("BEGIN");
      const c = db.prepare('INSERT INTO "Customer" (id, name, phone, school, remark, salesOwnerId, followStatus, decisionStatus, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)');
      const f = db.prepare('INSERT INTO "FollowUp" (id, type, title, content, status, occurredAt, customerId, ownerId, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)');
      const t0 = Date.now() - 400 * 86_400_000;
      for (let i = 0; i < 种子; i++) {
        const id = `seed_c${i}`, at = t0 + i * 1000;
        c.run(id, `老客户${i}-${批}`, `139${String(10_000_000 + i).slice(-8)}`, `某某有限公司${i % 500}`, `导入的老备注，第 ${i} 位，带一点长度：地址某省某市某区某路 ${i} 号`, 管理员, "待跟进", "了解中", at, at);
        for (let j = 0; j < 每位跟进; j++) f.run(`seed_f${i}_${j}`, "PHONE", "", `第 ${j + 1} 次电话：聊了报价和交期，客户说下周再定（${i}）`, "已完成", at + j * 60_000, id, 管理员, at + j * 60_000, at + j * 60_000);
      }
      db.exec("COMMIT");
    } finally { db.close(); }
    结果.阶段.写老数据 = { 秒: +((Date.now() - 起) / 1000).toFixed(1), 客户: 种子, 跟进: 种子 * 每位跟进, 老板库MB: MB(fs.statSync(老.库).size) };
    打(`老板库里写好老数据：${JSON.stringify(结果.阶段.写老数据)}`);
  }

  // 建团队 → 开通 → 老板范围迁移（老数据作为起点推上中转）
  let 码, 团队id;
  {
    const r = await 调(老, 动作.建团队, [`负载团队${批}`]);
    if (!r?.ok) throw new Error(`建团队：${JSON.stringify(r)}`);
    码 = r.邀请码; 团队id = 码.split(".")[1];
    const k = await 调动作(云, 表, 动作.开通团队, [{ token: 运营口令, teamId: 团队id, months: 1, seats: Math.max(台数, 账号数), amount: 0, note: "load" }], { 查询: `?token=${运营口令}` });
    结果.阶段.开通 = { 席位: Math.max(台数, 账号数), 回: k };
    if (!k?.ok) throw new Error(`开通：${JSON.stringify(k)}`);
    const 起 = Date.now();
    const 控制库 = path.join(云目录, "control.db");
    await 等到({
      步骤: "老板范围迁移", 哪台: "boss", 期望: "SyncPrivacy ready、本机 scoped.stage ready",
      取: () => ({ 阶段: 查库(控制库, "SELECT stage FROM SyncPrivacy WHERE teamId = ?", 团队id)[0]?.stage ?? null, 本机: 读团队文件(老)?.scoped?.stage ?? null, 错: 读团队文件(老)?.lastError ?? null }),
      满足: (v) => v.阶段 === "ready" && v.本机 === "ready", 超时: 30 * 60_000, 间隔: 1000,
    });
    结果.阶段.老数据上中转 = { 秒: +((Date.now() - 起) / 1000).toFixed(1), ...中转大小(), 云端: 段内云端(起, Date.now()), 流量: 段内流量(起, Date.now()) };
    打(`老板迁移完成：${JSON.stringify(结果.阶段.老数据上中转)}`);
  }

  // 2. 其余各台加入
  {
    const 起 = Date.now();
    const 失败 = [];
    for (const t of 台们.slice(1)) {
      const r = await 调(t, 动作.加入团队, [码]);
      if (!r?.ok) 失败.push(`${t.名}：${JSON.stringify(r).slice(0, 160)}`);
      else t.进了 = true;
    }
    const 进齐 = Date.now();
    const 在队 = 台们.filter((t) => t === 老 || t.进了);
    const 用时 = [];
    await 等到({
      步骤: "全员一致", 哪台: "全部", 期望: `每台范围 ready、同步过、没有 lastError、本机团队账号 ${账号数} 个；老板客户 ${种子}`,
      取: () => 在队.map((t) => {
        const c = 读团队文件(t);
        const ok = c?.scoped?.stage === "ready" && c?.lastSyncAt && Date.parse(c.lastSyncAt) > 进齐 && !c?.lastError && 数(t.库, "SELECT COUNT(*) AS n FROM User WHERE id LIKE 'acct_%'") === 账号数 && (t !== 老 || 数(t.库, "SELECT COUNT(*) AS n FROM Customer") >= 种子);
        if (ok && !t.齐了) { t.齐了 = Date.now() - 进齐; 用时.push(t.齐了); }
        return ok;
      }),
      满足: (v) => v.every(Boolean), 超时: 10 * 60_000, 间隔: 1000,
    }).catch((e) => 失败.push(`没全齐：${e.message.slice(0, 300)}`));
    结果.阶段.全员加入 = { 加入用时秒: +((进齐 - 起) / 1000).toFixed(1), 进了: 在队.length, 没进: 失败, 最后一台加入后到全员一致: 用时.length ? 分位(用时) : null, 云端: 段内云端(起, Date.now()), 流量: 段内流量(进齐, Date.now()) };
    打(`全员加入：${JSON.stringify(结果.阶段.全员加入)}`);
  }

  // 3. 空闲
  {
    const 起 = Date.now();
    await 停(空闲秒 * 1000);
    结果.阶段.空闲 = { 秒: 空闲秒, 流量: 段内流量(起, Date.now()), 云端: 段内云端(起, Date.now()), 一轮同步: 段内一轮(起, Date.now()) };
    打(`空闲 ${空闲秒} 秒：${JSON.stringify(结果.阶段.空闲)}`);
  }

  // 4. 每位业务员同时录 1 位客户 + 1 条跟进 → 老板多久看到
  {
    const 起 = Date.now();
    const 写了 = await Promise.all(业务员第一台.filter((t) => t.进了).map(async (t) => {
      const r = await 调(t, 动作.录客户, [{ name: `${t.名}-新客户-${批}`, phone: `137${String(10_000_000 + t.端口).slice(-8)}`, school: null, grade: null, major: null, followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null, remark: null, salesOwnerId: `acct_${t.账号}`, channelId: null, referrerCustomerId: null }]);
      if (!r?.ok) return { t, 错: JSON.stringify(r).slice(0, 120) };
      await 调(t, 动作.记跟进, [{ customerId: r.id, type: "PHONE", title: "", content: `${t.名} 记的新跟进`, status: "已完成", occurredAt: new Date().toISOString() }]);
      return { t, id: r.id, 写完: Date.now() };
    }));
    const 好的 = 写了.filter((x) => x.id);
    const 延迟 = [];
    await 等到({
      步骤: "老板收到业务员新写的", 哪台: "boss", 期望: `${好的.length} 位新客户和跟进都到`,
      取: () => 好的.map((x) => {
        if (x.到 == null && 数(老.库, "SELECT COUNT(*) AS n FROM FollowUp WHERE customerId = ?", x.id) > 0) { x.到 = Date.now() - x.写完; 延迟.push(x.到); }
        return x.到 != null;
      }),
      满足: (v) => v.every(Boolean), 超时: 5 * 60_000, 间隔: 250,
    }).catch(() => undefined);
    结果.阶段.业务员写老板看到 = { 写了: 好的.length, 写失败: 写了.filter((x) => x.错).map((x) => `${x.t.名}：${x.错}`), 到了: 延迟.length, ...(延迟.length ? 分位(延迟) : {}), 云端: 段内云端(起, Date.now()) };
    打(`业务员写 → 老板看到：${JSON.stringify(结果.阶段.业务员写老板看到)}`);
  }

  // 5. 老板打开互看 → 业务员拉全队老数据
  if (跑互看) {
    const 起 = Date.now();
    const r = await 调(老, 动作.设互看, [true]);
    if (!r?.ok) throw new Error(`设互看：${JSON.stringify(r)}`);
    const 应有 = 数(老.库, "SELECT COUNT(*) AS n FROM Customer");
    const 应有跟进 = 数(老.库, "SELECT COUNT(*) AS n FROM FollowUp");
    const 业务员们 = 台们.filter((t) => t !== 老 && t.进了);
    const 进度 = [];
    const 用时 = [];
    let 下次记 = Date.now();
    await 等到({
      步骤: "互看后业务员拉齐", 哪台: "全部业务员", 期望: `每台客户 ${应有}、跟进 ${应有跟进}`,
      取: () => {
        let 客户和 = 0;
        const 齐 = 业务员们.map((t) => {
          const n = 数(t.库, "SELECT COUNT(*) AS n FROM Customer"), f = 数(t.库, "SELECT COUNT(*) AS n FROM FollowUp");
          客户和 += n;
          if (n >= 应有 && f >= 应有跟进 && t.互看齐 == null) { t.互看齐 = Date.now() - 起; 用时.push(t.互看齐); }
          return n >= 应有 && f >= 应有跟进;
        });
        if (Date.now() >= 下次记) { 进度.push({ 秒: Math.round((Date.now() - 起) / 1000), 业务员平均客户: Math.round(客户和 / 业务员们.length), 齐了几台: 齐.filter(Boolean).length }); 下次记 = Date.now() + 15_000; 打(`互看进度 ${JSON.stringify(进度.at(-1))}`); }
        return 齐;
      },
      满足: (v) => v.every(Boolean), 超时: 互看超时, 间隔: 2000,
    }).catch(() => undefined);
    结果.阶段.互看拉全队 = { 应有客户: 应有, 应有跟进, 齐了: 用时.length, 共: 业务员们.length, ...(用时.length ? 分位(用时) : {}), 进度, 云端: 段内云端(起, Date.now()), 流量: 段内流量(起, Date.now()), 一轮同步: 段内一轮(起, Date.now()), 中转: 中转大小() };
    打(`互看：${JSON.stringify({ ...结果.阶段.互看拉全队, 进度: undefined })}`);
  }

  结果.全程云端 = 段内云端(总起, Date.now());
  结果.按路径 = Object.fromEntries([...计.路径].sort((a, b) => b[1].次 - a[1].次).slice(0, 12).map(([k, v]) => [k, { 次: v.次, 平均毫秒: Math.round(v.毫秒 / v.次), 最慢毫秒: v.最慢 }]));
  结果.没成的轮 = { 共: 没成的轮.length, 前几条: 没成的轮.slice(0, 15) };
  结果.中转最后 = 中转大小();
}

let 红 = null;
try {
  await 主线();
} catch (e) {
  红 = e;
  console.error(`\n红了：${e.message}`);
  结果.红 = String(e.message ?? e).slice(0, 2000);
} finally {
  for (const t of 台们) t.壳停 = true;
  clearInterval(采);
  const 文件 = path.join(根, ".bench", `负载-${台数}台-${种子}位-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.json`);
  fs.mkdirSync(path.dirname(文件), { recursive: true });
  fs.writeFileSync(文件, JSON.stringify(结果, null, 2));
  console.log(`\n结果写到 ${文件}`);
  await 全关();
  代理.close();
  if (!留着) fs.rmSync(临时, { recursive: true, force: true });
  else console.log(`临时目录留着：${临时}`);
  process.exit(红 ? 1 : 0);
}
