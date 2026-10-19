/**
 * 团队版从头到尾走一遍（2026-10-16 用户：「同步进行团队端的检验，确保完善好团队端」）。
 * 报告：~/Opensource_CRM/03-测试/团队版全面检验-20261016.md（场景 × 结果 × 问题 × 严重程度）。
 *
 * 一个老板 + 两个业务员，每人 1–3 台设备（电脑 + 手机），按真实使用的顺序串起来：
 *   建团队 → 待开通 → 运营台按时长开通 → 邀请码加入（加入前本机已有客户、模版币种以团队为准）→ 范围同步
 *   → 本人新电脑配对（首页 / 设置页同一个申请，电脑批、手机批、老板第二台的管理权限）→ 每人 3 台上限 → 我的设备 / 移除设备
 *   → 公海领取、交接、转走后的推送被拒不丢 → 断网时两边改同一位客户 → 手机离线记跟进再联网
 *   → 快到期提醒 / 到期暂停 / 续费恢复 → 改名 → 移除同事（换钥匙）→ 退出团队 / 重新加入
 *   → 0.46.16 时建的单设备团队升级后再加设备；一路核「没同步上」「疑似重复」「待老板核对」这几张清单。
 * 每一步除了数据对不对，还核给人看的那句话（界面原样显示的 error / lastError）说得清、知道下一步做什么。
 *
 * 台子照抄 sync-device-link-merge.test.ts：真实桌面端 lib/sync/client.ts + 真实中转（临时控制库、令牌真签发、路由顺序照 route.ts），
 * 手机走 lib/mobile（内存库）。服务端开着范围同步（正式服 CRM_SCOPED_SYNC=1）。一次跑完约 10 秒，改团队代码都该跑它。
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 电脑们 = ["boss", "boss2", "li", "li2", "li3", "zhao", "old", "old2"] as const;
type 谁 = (typeof 电脑们)[number];
const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-team-full-"));
  for (const who of ["boss", "boss2", "li", "li2", "li3", "zhao", "old", "old2"]) {
    fs.mkdirSync(path.join(root, who), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(root, who, "crm.db"));
    if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(root, who, "crm.db-wal"));
  }
  return { root, 谁: "boss" as string };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  const dbs: Record<string, InstanceType<typeof PrismaClient>> = {};
  for (const w of ["boss", "boss2", "li", "li2", "li3", "zhao", "old", "old2"]) dbs[w] = new PrismaClient({ datasourceUrl: `file:${path.join(临时.root, w, "crm.db")}?connection_limit=1` });
  /*
    和真桌面端一样开库（src/lib/prisma.ts）：WAL + synchronous=NORMAL + 等锁 5 秒。
    原来没设，模拟的电脑跑在 SQLite 默认的 delete 日志模式、每次提交都刷盘：Windows CI 上每写一次都新建 / 删掉
    -journal 文件再刷盘，整份慢到本机的几十倍，退出团队那条（三台电脑各 VACUUM 一次）超过 20 秒（v0.46.19 desktop.yml）。
    而且擦净删除残留里截 WAL 那一步在 delete 模式下根本没走到——和真电脑不一样
  */
  for (const d of Object.values(dbs)) {
    await d.$queryRawUnsafe("PRAGMA journal_mode = WAL");
    await d.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
    await d.$queryRawUnsafe("PRAGMA synchronous = NORMAL");
  }
  (globalThis as { __dbs?: typeof dbs }).__dbs = dbs;
  const prisma = new Proxy({}, { get: (_t, p) => { const db = dbs[临时.谁] as unknown as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(db) : v; } });
  return { prisma };
});

import type { PrismaClient } from "@/generated/prisma";
import type { 传输 } from "@/lib/sync/client";
import * as 授权 from "@/lib/sync/mobile-desktop";
import * as 新机 from "@/lib/sync/device-link";
import * as 密 from "@/lib/sync/crypto-web";
import * as 手机 from "@/lib/mobile/sync";
import * as 连 from "@/lib/mobile/link";
import { 疑似重复 } from "@/lib/sync/dupes";
import { 没同步上 } from "@/lib/sync/local";
import { 列出范围冲突 } from "@/lib/sync/scoped-local";
import { 列出被盖, 看过被盖 } from "@/lib/sync/overwritten";

let client: typeof import("@/lib/sync/client");
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
let control: typeof import("@/lib/tenant/control").control;
let link: typeof import("@/lib/tenant/mobile-link");
let 令牌库: typeof import("@/lib/tenant/device-token");
let 我的: typeof import("@/lib/tenant/my-devices");
let 开通: typeof import("@/lib/tenant/team-plan");
let 账号名: typeof import("@/lib/tenant/account-name");

type 人 = "boss" | "li" | "zhao" | "old";
const 账号: Record<人, string> = { boss: "", li: "", zhao: "", old: "" };
const 账号的: Record<谁, 人> = { boss: "boss", boss2: "boss", li: "li", li2: "li", li3: "li", zhao: "zhao", old: "old", old2: "old" };
const 令牌: Record<string, string> = {};
const db = (w: 谁) => (globalThis as unknown as { __dbs: Record<string, PrismaClient> }).__dbs[w];
function 当(w: 谁) { 临时.谁 = w; process.env.CRM_DATA_DIR = path.join(临时.root, w); }
const A = (p: 人) => `acct_${账号[p]}`;

/** 假的「云端」：按令牌认人，路径和顺序照 src/app/api/**\/route.ts（scoped 先核设备再分动作） */
async function 调中转(raw: string, 方法: string, 路径: string, body: unknown) {
  const tk = await 令牌库.认领(raw);
  if (!tk) return { 状态: 401, json: { error: "登录已失效，请重新登录" } };
  const a = tk.accountId;
  const u = new URL(`http://x${路径}`);
  const b = (body ?? {}) as Record<string, unknown>;
  const 回 = (r: { ok: boolean; 状态?: number; error?: string }) => ({ 状态: r.ok ? 200 : (r.状态 ?? 500), json: r as unknown as Record<string, unknown> });
  if (u.pathname === "/api/account/name") {
    if (方法 === "GET") return 回(await 账号名.取账号名(a) as never);
    return 回(await 账号名.改账号名(a, b.name) as never);
  }
  if (u.pathname === "/api/sync/pricing") return { 状态: 200, json: { ok: true, ...(await 开通.公开价格()) } as Record<string, unknown> };
  if (u.pathname === "/api/sync/my-devices") {
    if (b.action === "list") return 回(await 我的.我的设备(a, String(b.teamId), tk.id) as never);
    if (b.action === "remove") return 回(await 我的.移除我的设备(a, String(b.teamId), String(b.device), tk.id));
  }
  if (u.pathname === "/api/sync/team" && 方法 === "GET") return { 状态: 200, json: { ok: true, teams: await relay.我的团队(a) } as Record<string, unknown> };
  if (u.pathname === "/api/sync/team") return 回(await relay.建团队(a, String(b.name), { device: String(b.device), pubKey: String(b.pubKey), tokenId: tk.id }));
  if (u.pathname === "/api/sync/join") return 回(await relay.入队(a, String(b.teamId), String(b.joinSecret), { device: String(b.device), pubKey: String(b.pubKey), tokenId: tk.id }));
  if (u.pathname === "/api/sync/key") return 回(await relay.取钥匙(a, u.searchParams.get("teamId")!, u.searchParams.get("device")!));
  if (u.pathname === "/api/sync/pull") return 回(await relay.给拉取(a, u.searchParams.get("teamId")!, Number(u.searchParams.get("after"))));
  if (u.pathname === "/api/sync/push") return 回(await relay.收推送(a, String(b.teamId), String(b.device), String(b.data)));
  if (u.pathname === "/api/sync/leave") return 回(await relay.退队(a, String(b.teamId), typeof b.device === "string" ? b.device : undefined));
  if (u.pathname === "/api/sync/remove") return 回(await relay.移除成员(a, String(b.teamId), String(b.accountId)));
  if (u.pathname === "/api/sync/secret") return 回(await relay.换口令(a, String(b.teamId)));
  if (u.pathname === "/api/sync/devices") return 回(await relay.团队设备(a, u.searchParams.get("teamId")!));
  if (u.pathname === "/api/sync/rotate") return 回(await relay.换钥匙(a, String(b.teamId), Number(b.epoch), String(b.ring), b.envelopes as never));
  if (u.pathname === "/api/sync/scoped") {
    const t = String(b.teamId), act = String(b.action);
    try {
      if (act !== "state" && !(await scoped.范围开放(t))) return { 状态: 404, json: { error: "范围同步尚未开放" } };
      if (act === "state") return { 状态: 200, json: await scoped.范围状态(a, t) as unknown as Record<string, unknown> };
      if (act === "directory" || act === "pull" || act === "push") await scoped.核设备(a, t, b.device, tk.id);
      let r: unknown;
      if (act === "directory") r = await scoped.范围目录(a, t);
      else if (act === "begin") r = await scoped.开始范围迁移(a, t, String(b.device));
      else if (act === "commit") r = await scoped.完成范围迁移(a, t, String(b.device), Number(b.count));
      else if (act === "push") r = await scoped.收范围推送(a, t, String(b.device), b.packets as never[]);
      else r = await scoped.给范围拉取(a, t, String(b.scopeId), Number(b.after));
      return { 状态: 200, json: r as Record<string, unknown> };
    } catch (e) {
      if (e instanceof scoped.范围错误) return { 状态: e.状态, json: e.denied ? { error: e.message, denied: e.denied, ...(e.gone?.length ? { gone: e.gone } : {}) } : { error: e.message } };
      throw e;
    }
  }
  if (u.pathname === "/api/mobile/link") {
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    const act = b.action;
    if (act === "request") return 回(await link.申请(a, tk.id, { device: b.device, pubKey: b.pubKey, label: b.label }));
    if (act === "status") return 回(await link.我的申请(a, tk.id));
    if (act === "pending") return 回(await link.待授权(a) as never);
    if (act === "challenge") return 回(await link.挑战(a, s(b.id), s(b.teamId), s(b.device)));
    if (act === "approve") return 回(await link.允许(a, s(b.id), s(b.teamId), s(b.sealed), s(b.nonce)));
    if (act === "deny") return 回(await link.拒绝(a, s(b.id)));
    if (act === "list") return 回(await link.已连接(a) as never);
    if (act === "remove") return 回(await link.移除(a, s(b.id)));
  }
  return { 状态: 404, json: { error: `fake: ${路径}` } };
}
/** 断网开关：断了的设备调什么都是「连不上云端」（和 client.ts 的 HTTP 传输说同一句） */
const 断网 = new Set<string>();
const 过线 = (x: { 状态: number; json: Record<string, unknown> }) => ({ 状态: x.状态, json: JSON.parse(JSON.stringify(x.json)) as Record<string, unknown> });
const 连不上 = { 状态: 0, json: { error: "连不上云端，检查一下网络" } };
const 桌面传: 传输 = async (方法, 路径, body) => (断网.has(临时.谁) ? 连不上 : 过线(await 调中转(令牌[临时.谁], 方法, 路径, body)));
const 用令牌 = (名: string): 手机.传输 => async (方法, 路径, body) => (断网.has(名) ? 连不上 : 过线(await 调中转(令牌[名], 方法, 路径, body)));

/** 桌面端模板库里固定种的三个账号（scripts/build-template.mjs） */
const 模板 = { 管理员: "cmusc55660000dulko96ek8kr", 张三: "cmusc55680001dulki71dcsts", 李四: "cmusc55690002dulk1u0ifs17" };
async function 清空种模板(d: PrismaClient) {
  for (const t of ["AiMessage", "AiConversation", "AiProject", "Setting", "AuditLog", "ImportRow", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerClaim", "CustomerPool"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  const 起 = new Date("2026-10-01T00:00:00Z");
  await d.user.create({ data: { id: 模板.管理员, email: "admin", name: "管理员", role: "ADMIN", password: "x", title: "管理员", createdAt: 起 } });
  await d.user.create({ data: { id: 模板.张三, email: "zhangsan", name: "张三", role: "SALES", password: "x", title: "销售", createdAt: 起 } });
  await d.user.create({ data: { id: 模板.李四, email: "lisi", name: "李四", role: "SALES", password: "x", title: "销售", createdAt: 起 } });
}
const 业务配置 = (币种: string) => JSON.stringify({ currency: 币种, template: 币种 === "CNY" ? "edu" : "trade" });
/** 给一台电脑登录云端账号（写 .cloud.json，和桌面端「登录」之后一样） */
async function 登录(w: 谁, 机名 = `${w}-机器`) {
  const 号 = 账号[账号的[w]];
  令牌[w] = (await 令牌库.签发(号, 机名)).token;
  fs.writeFileSync(path.join(临时.root, w, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: 令牌[w], accountId: 号, name: 账号的[w], contact: `${账号的[w]}@example.invalid`, models: [], loggedAt: new Date().toISOString() }));
}
const 轮 = async (w: 谁) => { 当(w); return client.同步一轮(); };
const 都轮 = async (...ws: 谁[]) => { for (const w of ws) expect(await 轮(w), w).toMatchObject({ ok: true }); };
const 读配置 = (w: 谁) => { 当(w); return client.读团队()!; };
const 客户们 = async (w: 谁) => (await db(w).customer.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((c) => c.id);
const 设置 = async (w: 谁) => (await db(w).setting.findUnique({ where: { key: "business" } }))?.value ?? null;
const 状态 = async (w: 谁) => { 当(w); return client.团队状态(); };
const 在团队的状态 = async (w: 谁) => { const s = await 状态(w); if (!s.在团队) throw Error(`${w} 不在团队里`); return s; };
/** 「没同步上」「待老板核对」「回放跳过」「被同事盖掉」几张清单（设置 → 团队里给人看的）：默认都要是空的 */
async function 清单(w: 谁) {
  当(w);
  return {
    没同步上: (await 没同步上(db(w))).条数,
    待核对: (await client.范围同步概况()).冲突,
    跳过: ((await db(w).$queryRawUnsafe("SELECT tbl, pk, why FROM _sync_skip")) as unknown[]).length,
    被盖: (await 列出被盖(db(w))).length,
  };
}
async function 都干净(...ws: 谁[]) { for (const w of ws) expect(await 清单(w), w).toEqual({ 没同步上: 0, 待核对: 0, 跳过: 0, 被盖: 0 }); }
/** 在本人已连上的电脑上批准（电脑的授权框）。返回批准结果（满了会失败） */
async function 电脑批(w: 谁) {
  当(w);
  const p = await 授权.待授权手机();
  expect(p.ok && p.手机.length, `${w} 待授权`).toBe(1);
  return 授权.允许手机(p.ok ? p.手机[0].id : "");
}

/* ---------------- 手机（浏览器版 /m，lib/mobile） ---------------- */
type 一部手机 = { 名: string; 团: 手机.手机团队; 库: 手机.内存库; 态: 手机.同步状态; 云: 手机.传输 };
const 手机们: Record<string, 一部手机> = {};
/** 手机登录（令牌）→ 发申请 → 本人电脑批 → 拿到团队身份，同步一轮 */
async function 连手机(名: string, p: 人, 批的电脑: 谁) {
  令牌[名] = (await 令牌库.签发(账号[p], `手机 · ${名}`)).token;
  const 钥 = await 密.设备钥匙对();
  const device = 连.新设备号();
  const 云 = 用令牌(名);
  const 申 = await 云("POST", "/api/mobile/link", { action: "request", device, pubKey: 钥.公钥, label: `iPhone · ${名}` });
  if (申.状态 !== 200) return { ok: false as const, error: String(申.json.error) };
  const 批 = await 电脑批(批的电脑);
  if (!批.ok) return 批;
  const r = await 连.查申请(云, { device, 私钥: 钥.私钥 });
  if (r.status !== "approved") throw Error(`${名} 没批下来：${r.status}`);
  const 机: 一部手机 = { 名, 团: r.团队, 库: new 手机.内存库(), 态: 手机.新状态(), 云 };
  手机们[名] = 机;
  await 手机轮(名);
  return { ok: true as const };
}
async function 手机轮(名: string) {
  const 机 = 手机们[名];
  try {
    const x = await 手机.同步一轮(机.团, 机.云, 机.库, 机.态);
    机.团 = x.c;
    return { ok: true as const, ...x };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}
/**
 * 被移出 / 退出后桌面端在后台自动退出（client.ts 被移出后收拾，不等人点）。一个进程模拟好几台电脑：
 * 一直停在这台上等它退完（.team.json 没了、退出那一下也收尾了），再切去别的电脑
 */
async function 等自动退出(w: 谁) {
  for (let i = 0; i < 100 && 读配置(w); i++) await new Promise((x) => setTimeout(x, 20));
  当(w);
  await client.退出团队();
  expect(读配置(w)).toBeNull();
}
const 手机客户 = (名: string) => 手机们[名].库.表("Customer").map((r) => String(r.id)).sort();

beforeAll(async () => {
  process.env.MULTI_TENANT = "1";
  process.env.DESKTOP_LOCAL = "1";
  process.env.CRM_SCOPED_SYNC = "1";
  process.env.SYNC_DIR = path.join(临时.root, "sync");
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时.root, "control.db")}`;
  const sql = execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(临时.root, "schema.sql"), sql);
  execFileSync(process.execPath, ["--experimental-sqlite", "-e", "const fs=require('node:fs');const d=new(require('node:sqlite').DatabaseSync)(process.argv[1]);d.exec(fs.readFileSync(process.argv[2],'utf8'));d.close()", path.join(临时.root, "control.db"), path.join(临时.root, "schema.sql")], { stdio: "pipe" });
  ({ control } = await import("@/lib/tenant/control"));
  relay = await import("@/lib/tenant/sync-relay");
  scoped = await import("@/lib/tenant/sync-scoped");
  link = await import("@/lib/tenant/mobile-link");
  我的 = await import("@/lib/tenant/my-devices");
  令牌库 = await import("@/lib/tenant/device-token");
  开通 = await import("@/lib/tenant/team-plan");
  账号名 = await import("@/lib/tenant/account-name");
  client = await import("@/lib/sync/client");
  const 名字: Record<人, string> = { boss: "王老板", li: "李业务", zhao: "赵业务", old: "老团队老板" };
  for (const p of ["boss", "li", "zhao", "old"] as const) 账号[p] = (await control.account.create({ data: { name: 名字[p], email: `${p}@example.invalid`, password: "not-a-login" } })).id;
  for (const w of 电脑们) { await 登录(w); await 清空种模板(db(w)); }
  client.设传输(桌面传);
}, 120_000);
afterAll(async () => {
  client?.设传输(null);
  for (const w of 电脑们) await db(w).$disconnect();
  await control?.$disconnect();
  for (const n of ["MULTI_TENANT", "DESKTOP_LOCAL", "SYNC_DIR", "CONTROL_DATABASE_URL", "CRM_DATA_DIR", "CRM_SCOPED_SYNC"]) delete process.env[n];
  fs.rmSync(临时.root, { recursive: true, force: true });
});

let 邀请码 = "";
let teamId = "";

describe("1. 建团队 → 待开通 → 运营台按时长开通", () => {
  it("老板（本机已有客户、人民币那套）建团队：拿到邀请码；还没开通，同步一轮说清楚是「还没开通」", async () => {
    await db("boss").setting.create({ data: { key: "business", value: 业务配置("CNY") } });
    await db("boss").customer.create({ data: { id: "c-boss-1", name: "老板的老客户", phone: "+8613900000001", salesOwnerId: 模板.管理员 } });
    当("boss");
    const r = await client.建团队("明亮贸易");
    if (!r.ok) throw Error(r.error);
    邀请码 = r.邀请码;
    teamId = 读配置("boss").teamId;
    expect(邀请码).toMatch(/^DT2\./);
    const 一轮 = await 轮("boss");
    expect(一轮).toEqual({ ok: false, error: "团队同步还没开通" });
    const s = await 在团队的状态("boss");
    expect(s).toMatchObject({ active: false, 已到期: false, 我是建的人: true, 能管理: true });
    // 界面：黄条「团队还没开通，暂不同步」，红条里不重复这句（TeamTab 过滤 /没开通|已到期/）
    expect(s.lastError).toMatch(/没开通/);
  });

  it("没开通时业务员也能先加入（本机已有客户、美元那套）：提示「团队开通后开始同步」", async () => {
    const d = db("li");
    await d.setting.create({ data: { key: "business", value: 业务配置("USD") } });
    await d.customer.create({ data: { id: "c-li-own", name: "李的老客户", phone: "+8613900000002", salesOwnerId: 模板.管理员 } });
    await d.followUp.create({ data: { id: "f-li-own", customerId: "c-li-own", ownerId: 模板.管理员, type: "PHONE", title: "", content: "加入前记的" } });
    // 和老板那位是同一个号码：加入后进「疑似重复」
    await d.customer.create({ data: { id: "c-li-dup", name: "老板的老客户（李录的）", phone: "+8613900000001", salesOwnerId: 模板.管理员 } });
    当("li");
    expect(await client.加入团队(邀请码)).toEqual({ ok: true, teamName: "明亮贸易", active: false });
    当("zhao");
    expect(await client.加入团队(邀请码)).toEqual({ ok: true, teamName: "明亮贸易", active: false });
    expect(await 轮("li")).toEqual({ ok: false, error: "团队同步还没开通" });
    const s = await 在团队的状态("li");
    expect(s).toMatchObject({ active: false, 已到期: false, 我是建的人: false });
    expect(s.成员.map((m) => m.name)).toEqual(["王老板", "李业务", "赵业务"]);
  });

  it("运营台开通（1 个月、3 个人，团队现在正好 3 人；10-19 起人数就是上限、满了拦，见 team-plan.test.ts）：开始同步，有效期和席位显示出来", async () => {
    const r = await 开通.开通续费({ teamId, 时长: { months: 1 }, seats: 3, amount: 89.7, by: "测试" });
    expect(r.ok).toBe(true);
    await 都轮("boss", "li", "zhao", "boss", "li", "zhao");
    const s = await 在团队的状态("boss");
    expect(s.active).toBe(true);
    expect(s.到期?.剩).toBeGreaterThanOrEqual(28);
    expect(s.席位).toBe(3);
    expect(s.成员).toHaveLength(3);
    expect(s.lastError).toBeNull();
  });
});

describe("2. 加入前本机已有的客户、模版币种、范围同步", () => {
  it("李加入前的客户带进团队、归李；老板看得到；赵看不到", async () => {
    for (const w of ["li", "boss"] as const) {
      expect(await db(w).customer.findUnique({ where: { id: "c-li-own" } }), w).toMatchObject({ salesOwnerId: A("li") });
      expect(await db(w).followUp.findUnique({ where: { id: "f-li-own" } }), w).toMatchObject({ ownerId: A("li"), content: "加入前记的" });
    }
    expect(await 客户们("zhao")).toEqual([]);
    // 老板的老客户归老板，业务员看不到
    expect(await db("boss").customer.findUnique({ where: { id: "c-boss-1" } })).toMatchObject({ salesOwnerId: A("boss") });
    expect(await db("li").customer.findUnique({ where: { id: "c-boss-1" } })).toBeNull();
  });

  it("模版、币种以团队（老板那套）为准：李原来的美元那套被换掉，没推上去", async () => {
    expect(await 设置("boss")).toBe(业务配置("CNY"));
    expect(await 设置("li")).toBe(业务配置("CNY"));
    expect(await 设置("zhao")).toBe(业务配置("CNY"));
  });

  it("业务员只看自己 + 公海，老板看全部：各录一位、老板放一位进公海", async () => {
    await db("zhao").customer.create({ data: { id: "c-zhao-1", name: "赵的客户", phone: "+8613900000003", salesOwnerId: A("zhao") } });
    await db("boss").customer.create({ data: { id: "c-pool-1", name: "公海里的", phone: "+8613900000004", salesOwnerId: A("boss") } });
    await db("boss").customerPool.create({ data: { customerId: "c-pool-1", userId: A("boss"), reason: "手动" } });
    await 都轮("zhao", "boss", "li", "zhao", "boss");
    expect(await 客户们("boss")).toEqual(["c-boss-1", "c-li-dup", "c-li-own", "c-pool-1", "c-zhao-1"]);
    expect(await 客户们("li")).toEqual(["c-li-dup", "c-li-own", "c-pool-1"]);
    expect(await 客户们("zhao")).toEqual(["c-pool-1", "c-zhao-1"]);
  });

  it("「疑似重复」：老板那台有（老板的老客户和李录的同一个号码）；李那台看不到老板那份，也就不提示", async () => {
    当("boss");
    const 组 = (await 疑似重复()).find((g) => g.记录.some((r) => r.id === "c-boss-1"));
    expect(组?.记录.map((r) => r.id).sort()).toEqual(["c-boss-1", "c-li-dup"]);
    当("li");
    expect((await 疑似重复()).find((g) => g.记录.some((r) => r.id === "c-li-dup"))).toBeUndefined();
    await 都干净("boss", "li", "zhao");
  });
});

describe("3. 本人新电脑配对、手机、每人 3 台上限、我的设备、移除设备", () => {
  it("李的新电脑 li2（空的）：首页 / 设置页看到「这台还没连上明亮贸易」；再点一次配对数字不变", async () => {
    当("li2");
    expect(await 新机.连接概况()).toEqual({ 云上的团: { id: teamId, name: "明亮贸易", 我是建的人: false }, 等授权: null, 本机客户: 0 });
    const a = await 新机.发起连接();
    const b = await 新机.发起连接();
    expect(a.ok && b.ok && a.配对数字 === b.配对数字).toBe(true);
    expect((await 新机.连接概况()).等授权).toEqual({ 配对数字: a.ok ? a.配对数字 : "" });
    // 李的电脑上弹出授权框：标着是电脑、配对数字对得上
    当("li");
    const p = await 授权.待授权手机();
    expect(p.ok && p.手机).toEqual([expect.objectContaining({ 电脑: true, label: expect.stringMatching(/（(Mac|Windows|电脑)）$/), 配对数字: a.ok ? a.配对数字 : "" })]);
  });

  it("李的电脑批准 → li2 连上，收到李的客户 + 公海；业务员的 li2 管不了团队", async () => {
    expect(await 电脑批("li")).toEqual({ ok: true });
    当("li2");
    expect(await 新机.查连接()).toEqual({ ok: true, status: "joined", teamName: "明亮贸易" });
    await 都轮("li2", "li", "li2");
    expect(await 客户们("li2")).toEqual(await 客户们("li"));
    expect(client.能管理团队(读配置("li2"))).toBe(false);
    const s = await 在团队的状态("li2");
    expect(s.我是建的人).toBe(false);
    expect(s.lastError).toBeNull();
    await 都干净("li2");
  });

  it("李的手机（li-m）也连上：第 3 台；手机上看到的客户和李的电脑一样", async () => {
    expect(await 连手机("li-m", "li", "li")).toEqual({ ok: true });
    expect(手机客户("li-m")).toEqual(await 客户们("li"));
  });

  it("第 4 台（li3）：发申请当场就说满了、怎么办", async () => {
    当("li3");
    const r = await 新机.发起连接();
    expect(r).toEqual({ ok: false, error: "一个人在团队里最多 3 台设备（电脑和手机合计）：先在电脑上「设置 → 团队 → 我的设备」里移除一台不用的" });
  });

  it("我的设备：李看到自己的 3 台（两台电脑带机器名、手机带型号），这台标出来；看不到别人的", async () => {
    当("li");
    const r = await 授权.我的设备();
    if (!r.ok) throw Error(r.error);
    expect(r.上限).toBe(3);
    expect(r.设备.map((d) => [d.种类, d.label, d.这台])).toEqual([["电脑", "li-机器", true], ["电脑", "li2-机器", false], ["手机", "iPhone · li-m", false]]);
    当("li2");
    const r2 = await 授权.我的设备();
    expect(r2.ok && r2.设备.filter((d) => d.这台).map((d) => d.label)).toEqual(["li2-机器"]);
  });

  it("老板的第二台电脑 boss2：建团队那台批准 → 能管理团队、看得到邀请码；老板的手机由 boss2 批准", async () => {
    当("boss2");
    expect((await 新机.连接概况()).云上的团).toMatchObject({ 我是建的人: true });
    expect((await 新机.发起连接()).ok).toBe(true);
    expect(await 电脑批("boss")).toEqual({ ok: true });
    当("boss2");
    expect(await 新机.查连接()).toMatchObject({ status: "joined" });
    await 都轮("boss2", "boss2");
    const s = await 在团队的状态("boss2");
    expect(s).toMatchObject({ 我是建的人: true, 能管理: true, lastError: null });
    expect(s.邀请码).toMatch(/^DT2\./);
    expect(await 客户们("boss2")).toEqual(await 客户们("boss"));
    expect(await 连手机("boss-m", "boss", "boss2")).toEqual({ ok: true });
    expect(手机客户("boss-m")).toEqual(await 客户们("boss"));
  });

  it("李在主力电脑上移除 li2：li2 立刻停同步（登录失效）；老板那台补换一把钥匙；李的电脑和手机照常收发", async () => {
    // li2 离线时记了一笔，还没推上去
    断网.add("li2");
    await db("li2").followUp.create({ data: { id: "f-li2-offline", customerId: "c-li-own", ownerId: A("li"), type: "PHONE", title: "", content: "li2 断网时记的" } });
    当("li");
    const 设备们 = await 授权.我的设备();
    const li2 = 设备们.ok ? 设备们.设备.find((d) => d.label === "li2-机器")! : null;
    expect(await 授权.移除设备(li2!.device)).toEqual({ ok: true });
    // 正在用的这台不能在这里移除
    expect(await 授权.移除设备(读配置("li").device)).toEqual({ ok: false, error: "正在用的这台不能在这里移除：要让这台停止同步，请点「退出团队」" });
    断网.delete("li2");
    expect(await 轮("li2")).toEqual({ ok: false, error: "登录已失效，请重新登录" });
    const 前 = 读配置("boss").epoch ?? 0;
    当("boss");
    expect(await client.老板补换钥匙(true)).toEqual({ ok: true, 换了: true });
    expect(读配置("boss").epoch).toBe(前 + 1);
    await db("li").followUp.create({ data: { id: "f-li-after-rm", customerId: "c-li-own", ownerId: A("li"), type: "PHONE", title: "", content: "移除 li2 之后记的" } });
    await 都轮("li", "boss", "boss2", "zhao", "li");
    expect(await 手机轮("li-m")).toMatchObject({ ok: true });
    expect(手机们["li-m"].库.表("FollowUp").map((r) => r.id)).toContain("f-li-after-rm");
    expect(await db("boss").followUp.findUnique({ where: { id: "f-li-after-rm" } })).toBeTruthy();
    await 都干净("li", "boss", "boss2", "zhao");
  });

  it("li2 重新登录：同步说清楚「这台已从我的设备里移除」，断网时那笔改动没被当成「待老板核对」", async () => {
    await 登录("li2");
    const r = await 轮("li2");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/已经从「我的设备」里移除/);
    expect(!r.ok && r.error).toMatch(/退出团队/);
    expect(await 清单("li2")).toMatchObject({ 待核对: 0 });
  });

  it("li2 点「退出团队」：只清这台（李的电脑、手机还在团队里）；之后可以重新配对连回来", async () => {
    当("li2");
    expect(await client.退出团队()).toEqual({ ok: true });
    expect(client.读团队()).toBeNull();
    const s = await 在团队的状态("li");
    expect(s.被移出).toBe(false);
    expect(s.成员.map((m) => m.name)).toContain("李业务");
    当("li2");
    expect((await 新机.连接概况()).云上的团).toMatchObject({ name: "明亮贸易" });
  });

  it("满了腾出一台后，第三台电脑 li3 由李的手机批准：连上能同步，没有邀请码、管不了团队", async () => {
    当("li3");
    expect((await 新机.发起连接()).ok).toBe(true);
    const 机 = 手机们["li-m"];
    const [x] = await 连.待授权的(机.云);
    expect(x).toMatchObject({ 电脑: true });
    await 连.允许设备(机.云, 机.团, "明亮贸易", x.id);
    当("li3");
    expect(await 新机.查连接()).toMatchObject({ status: "joined" });
    await 都轮("li3", "li3");
    expect(await 客户们("li3")).toEqual(await 客户们("li"));
    const s = await 在团队的状态("li3");
    expect(s.邀请码).toBe("");
    expect(s.能管理).toBe(false);
  });

  it("李在主力电脑上移除手机：手机下一轮是「登录已失效」（手机界面据此清掉客户数据）", async () => {
    当("li");
    const r = await 授权.我的设备();
    const m = r.ok ? r.设备.find((d) => d.种类 === "手机")! : null;
    expect(await 授权.移除设备(m!.device)).toEqual({ ok: true });
    const x = await 手机轮("li-m");
    expect(x.ok).toBe(false);
    expect(!x.ok && x.error).toMatch(/登录已失效/);
    当("boss");
    expect(await client.老板补换钥匙(true)).toEqual({ ok: true, 换了: true });
    await 都轮("li", "li3", "boss", "boss2", "zhao", "li", "li3");
    await 都干净("li", "li3", "boss", "boss2", "zhao");
  });
});

/** 按界面背后的顺序做（customers/pool-actions.ts 领取：先改负责人、记领取、最后删公海那一行） */
async function 领取(w: 谁, 我: 人, id: string) {
  当(w);
  await db(w).$transaction(async (tx) => {
    await tx.customer.update({ where: { id }, data: { salesOwnerId: A(我) } });
    await tx.customerClaim.upsert({ where: { customerId: id }, update: { userId: A(我), at: new Date() }, create: { customerId: id, userId: A(我) } });
    await tx.customerPool.delete({ where: { customerId: id } });
  });
}
/** 客户页改负责人（交接）：客户和没做完的计划一起转 */
async function 交接(w: 谁, id: string, 给: 人) {
  当(w);
  await db(w).$transaction(async (tx) => {
    await tx.customer.update({ where: { id }, data: { salesOwnerId: A(给) } });
    await tx.followPlan.updateMany({ where: { customerId: id, done: false }, data: { ownerId: A(给) } });
  });
}

describe("3b. 被移除的 li2 重新配对", () => {
  it("li2 重新连上（李的主力电脑批准）：它被移除前断网记的那笔这回带上去了，没丢、也没进「待核对」", async () => {
    当("li2");
    expect(await db("li2").followUp.findUnique({ where: { id: "f-li2-offline" } })).toMatchObject({ content: "li2 断网时记的" });
    expect((await 新机.发起连接()).ok).toBe(true);
    expect(await 电脑批("li")).toEqual({ ok: true });
    当("li2");
    expect(await 新机.查连接()).toMatchObject({ status: "joined" });
    await 都轮("li2", "li", "boss", "li2");
    expect(await db("li").followUp.findUnique({ where: { id: "f-li2-offline" } })).toMatchObject({ content: "li2 断网时记的" });
    expect(await db("boss").followUp.findUnique({ where: { id: "f-li2-offline" } })).toBeTruthy();
    await 都干净("li2", "li", "boss");
  });
});

describe("4. 公海领取、交接、转走后的推送被拒不丢", () => {
  it("赵的手机（zhao-m）连上", async () => {
    expect(await 连手机("zhao-m", "zhao", "zhao")).toEqual({ ok: true });
    expect(手机客户("zhao-m")).toEqual(await 客户们("zhao"));
  });

  it("李在电脑上领取公海那位：老板那边负责人变李；赵那台和赵的手机上这位走了", async () => {
    await 领取("li", "li", "c-pool-1");
    await 都轮("li", "boss", "zhao", "li3");
    expect(await 手机轮("zhao-m")).toMatchObject({ ok: true });
    expect(await db("boss").customer.findUnique({ where: { id: "c-pool-1" } })).toMatchObject({ salesOwnerId: A("li") });
    expect(await db("boss").customerPool.findUnique({ where: { customerId: "c-pool-1" } })).toBeNull();
    expect(await db("li3").customer.findUnique({ where: { id: "c-pool-1" } })).toMatchObject({ salesOwnerId: A("li") });
    expect(await 客户们("zhao")).toEqual(["c-zhao-1"]);
    expect(手机客户("zhao-m")).toEqual(["c-zhao-1"]);
    await 都干净("li", "boss", "zhao", "li3");
  });

  it("交接带计划：李把自己的老客户交给赵；同时 li3 断着网改了这位的备注 → li3 联网后这笔被拒，但没丢：进了 li3 的「待核对」清单，说得清为什么", async () => {
    await db("li").followPlan.create({ data: { id: "p-li-own", subject: "下周回访", plannedAt: new Date("2026-10-20T02:00:00Z"), customerId: "c-li-own", ownerId: A("li") } });
    await 都轮("li", "li3");
    断网.add("li3");
    await db("li3").customer.update({ where: { id: "c-li-own" }, data: { remark: "li3 断网时改的备注" } });
    await new Promise((r) => setTimeout(r, 5));
    await 交接("li", "c-li-own", "zhao");
    await 都轮("li", "boss", "zhao");
    expect(await db("zhao").customer.findUnique({ where: { id: "c-li-own" } })).toMatchObject({ salesOwnerId: A("zhao") });
    expect(await db("zhao").followPlan.findUnique({ where: { id: "p-li-own" } })).toMatchObject({ ownerId: A("zhao") });
    expect(await db("zhao").followUp.findUnique({ where: { id: "f-li-own" } })).toMatchObject({ content: "加入前记的" });
    expect(await db("li").customer.findUnique({ where: { id: "c-li-own" } })).toBeNull();
    断网.delete("li3");
    await 都轮("li3");
    expect(await db("li3").customer.findUnique({ where: { id: "c-li-own" } })).toBeNull();
    当("li3");
    const 冲突 = await 列出范围冲突(db("li3"));
    expect(冲突).toEqual([expect.objectContaining({ 表: "客户", 编号: "c-li-own", 名称: "c-li-own", 操作: "修改", 改动列: ["备注"], 原因: expect.stringMatching(/不在你的同步范围内/) })]);
    expect(await 清单("li3")).toMatchObject({ 待核对: 1, 没同步上: 0 });
    // 老板那边这位的备注没被 li3 的旧改动盖掉（被拒的没落库）
    expect((await db("boss").customer.findUnique({ where: { id: "c-li-own" } }))?.remark ?? null).not.toBe("li3 断网时改的备注");
    // 导出给老板核对后点「标记已处理」：清单清空，记录还在（导出里看得到）
    当("li3");
    const { 确认范围冲突, 导出范围冲突 } = await import("@/lib/sync/scoped-local");
    expect(JSON.parse(await 导出范围冲突(db("li3"))).条目[0]).toMatchObject({ 编号: "c-li-own", 改动内容: { remark: "li3 断网时改的备注" } });
    expect(await 确认范围冲突(db("li3"), 冲突.map((x) => x.id))).toBe(1);
    expect(await 清单("li3")).toMatchObject({ 待核对: 0 });
  });

  it("手机断网时给自己的客户记了一笔跟进，这期间赵在电脑上把这位交给了李 → 手机联网后这笔被拒、留在「没同步上」里可复制，不悄悄丢", async () => {
    断网.add("zhao-m");
    const 机 = 手机们["zhao-m"];
    await 手机.记跟进(机.团, 机.库, 机.态, { customerId: "c-zhao-1", type: "PHONE", content: "手机断网时记的：客户说下周下单" });
    expect(机.态.待推).toHaveLength(2);
    expect(await 手机轮("zhao-m")).toEqual({ ok: false, error: "连不上云端，检查一下网络" });
    await new Promise((r) => setTimeout(r, 5));
    await 交接("zhao", "c-zhao-1", "li");
    await 都轮("zhao", "boss", "li");
    断网.delete("zhao-m");
    const r = await 手机轮("zhao-m");
    expect(r).toMatchObject({ ok: true, 拒: 1 });
    expect(机.态.待推).toEqual([]);
    // 界面「没同步上」只列跟进（MobileApp 快照只取 FollowUp）；它的操作日志跟着一起挪进被拒，没推上去
    expect(机.态.被拒.map((x) => [x.改动.t, x.原因])).toEqual([["FollowUp", "这位客户已经不归你了，这条没同步上"], ["AuditLog", "这位客户已经不归你了，这条没同步上"]]);
    // 这笔跟进的操作日志也不该推上去：不然老板的操作日志里写着「记了一条跟进」，跟进却不在
    await 都轮("boss");
    expect(await db("boss").auditLog.count({ where: { summary: { contains: "电话沟通跟进" }, userId: A("zhao") } })).toBe(0);
    expect(String(机.态.被拒[0].改动.r?.content)).toBe("手机断网时记的：客户说下周下单");
    // 客户已经从手机上走了；李那边这位没有这笔（被拒的没落库）
    expect(手机客户("zhao-m")).toEqual(["c-li-own"]);
    expect(await db("li").followUp.count({ where: { customerId: "c-zhao-1", content: { contains: "手机断网时记的" } } })).toBe(0);
  });

  it("手机离线给自己的客户记跟进（带下次计划），联网后电脑和老板都收到", async () => {
    断网.add("zhao-m");
    const 机 = 手机们["zhao-m"];
    const { id } = await 手机.记跟进(机.团, 机.库, 机.态, { customerId: "c-li-own", type: "VISIT", content: "上门看了样品", 下次: { 时间: Date.parse("2026-10-22T02:00:00Z"), 主题: "签合同", 方式: "电话" } });
    断网.delete("zhao-m");
    expect(await 手机轮("zhao-m")).toMatchObject({ ok: true, 推: 4, 拒: 0 });
    await 都轮("zhao", "boss");
    for (const w of ["zhao", "boss"] as const) {
      expect(await db(w).followUp.findUnique({ where: { id } }), w).toMatchObject({ content: "上门看了样品", ownerId: A("zhao"), customerId: "c-li-own" });
      expect(await db(w).followPlan.count({ where: { customerId: "c-li-own", subject: "签合同" } }), w).toBe(1);
    }
    await 都干净("zhao", "boss");
  });
});

describe("5. 断网时两边改同一位客户（后改的赢；被盖掉的一方有提示）", () => {
  it("老板、赵都断着网改同一位：不同字段两边都留；同一字段后改的赢（不看谁先联网）；两边最后一样", async () => {
    断网.add("boss"); 断网.add("zhao");
    await db("zhao").customer.update({ where: { id: "c-li-own" }, data: { remark: "赵先改的备注", school: "赵填的院校" } });
    await new Promise((r) => setTimeout(r, 10));
    await db("boss").customer.update({ where: { id: "c-li-own" }, data: { remark: "老板后改的备注", major: "老板填的专业" } });
    // 后改的老板先联网、先改的赵后联网：赵的旧改动不能盖掉老板的
    断网.delete("boss");
    await 都轮("boss");
    断网.delete("zhao");
    await 都轮("zhao", "boss", "zhao");
    for (const w of ["boss", "zhao"] as const) {
      expect(await db(w).customer.findUnique({ where: { id: "c-li-own" } }), w).toMatchObject({ remark: "老板后改的备注", school: "赵填的院校", major: "老板填的专业" });
    }
  });

  it("被盖掉的赵那边有提示：哪位客户、哪一格、他原来写的、现在是什么；老板那边（赢的一方）没有", async () => {
    当("zhao");
    const 列 = await 列出被盖(db("zhao"));
    expect(列).toEqual([expect.objectContaining({ 表: "客户", 名称: "李的老客户", 列: "备注", 我写的: "赵先改的备注", 现在: "老板后改的备注", href: "/customers/c-li-own" })]);
    当("boss");
    expect(await 列出被盖(db("boss"))).toEqual([]);
    // 其余几张清单照旧是空的：这不是「没同步上」，也不是「待核对」
    const s = await 在团队的状态("zhao");
    expect(s.没同步上.条数).toBe(0);
    expect(s.范围?.冲突 ?? 0).toBe(0);
    // 点「知道了」：不再提示
    当("zhao");
    expect(await 看过被盖(db("zhao"), 列.map((x) => x.id))).toBe(1);
    expect(await 列出被盖(db("zhao"))).toEqual([]);
  });

  it("正常接着改不提示：赵联网改了备注、传上去之后，老板看到再改——赵那边不冒提示", async () => {
    await db("zhao").customer.update({ where: { id: "c-li-own" }, data: { remark: "赵联网改的" } });
    await 都轮("zhao", "boss");
    await new Promise((r) => setTimeout(r, 5));
    await db("boss").customer.update({ where: { id: "c-li-own" }, data: { remark: "老板看到之后接着改的" } });
    await 都轮("boss", "zhao");
    expect(await db("zhao").customer.findUnique({ where: { id: "c-li-own" } })).toMatchObject({ remark: "老板看到之后接着改的" });
    当("zhao");
    expect(await 列出被盖(db("zhao"))).toEqual([]);
  });

  it("没推上去时就被盖：赵断网改了电话和计划时间，老板联网后改了同一格 → 赵联网时提示；值一样的不提示", async () => {
    断网.add("zhao");
    await db("zhao").customer.update({ where: { id: "c-li-own" }, data: { phone: "+8613900000099", major: "赵改的行业" } });
    await db("zhao").followPlan.update({ where: { id: "p-li-own" }, data: { plannedAt: new Date(2026, 9, 21, 9, 30) } });
    await new Promise((r) => setTimeout(r, 5));
    await db("boss").customer.update({ where: { id: "c-li-own" }, data: { phone: "+8613900000088", major: "赵改的行业" } });
    await db("boss").followPlan.update({ where: { id: "p-li-own" }, data: { plannedAt: new Date(2026, 9, 22, 14, 0) } });
    await 都轮("boss");
    断网.delete("zhao");
    await 都轮("zhao", "boss", "zhao");
    当("zhao");
    // 日期按日期时间给人看，不露毫秒数
    expect((await 列出被盖(db("zhao"))).map((x) => [x.表, x.名称, x.列, x.我写的, x.现在]).sort()).toEqual([
      ["客户", "李的老客户", "联系电话", "+8613900000099", "+8613900000088"],
      ["跟进计划", "李的老客户 · 下周回访", "计划时间", "2026-10-21 09:30", "2026-10-22 14:00"],
    ]);
    await 看过被盖(db("zhao"), (await 列出被盖(db("zhao"))).map((x) => x.id));
  });
});

const 北京今天加 = (天: number) => new Date(Date.now() + 天 * 86_400_000);
describe("6. 快到期提醒 → 到期暂停 → 续费恢复（改动不丢）", () => {
  it("还剩 3 天：同步照常，状态里带着还剩几天（界面出黄条「还有 3 天到期」）", async () => {
    expect((await 开通.改到期({ teamId, paidUntil: 开通.当天结束(北京今天加(3)), by: "测试" })).ok).toBe(true);
    await 都轮("boss", "li");
    const s = await 在团队的状态("li");
    expect(s).toMatchObject({ active: true, 已到期: false, 到期: { 剩: 3 } });
    expect(s.lastError).toBeNull();
  });

  it("到期了：电脑、手机都暂停，说清楚是到期、数据照常能用、续费后自动恢复", async () => {
    expect((await 开通.改到期({ teamId, paidUntil: 开通.当天结束(北京今天加(-1)), by: "测试" })).ok).toBe(true);
    const r = await 轮("li");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^团队同步已到期（\d{4}-\d{2}-\d{2}），暂停同步：续费后自动恢复，这台电脑上的数据照常能用$/);
    const s = await 在团队的状态("li");
    expect(s).toMatchObject({ active: false, 已到期: true });
    const m = await 手机轮("zhao-m");
    expect(!m.ok && m.error).toMatch(/已到期/);
  });

  it("到期期间各自照常记：李录一位、赵在手机上记一笔", async () => {
    await db("li").customer.create({ data: { id: "c-li-during-expiry", name: "到期期间录的", phone: "+8613900000009", salesOwnerId: A("li") } });
    const 机 = 手机们["zhao-m"];
    await 手机.记跟进(机.团, 机.库, 机.态, { customerId: "c-li-own", type: "PHONE", content: "到期期间手机记的" });
    expect((await 轮("li")).ok).toBe(false);
  });

  it("续费 1 个月：自动恢复，到期期间的改动都补上", async () => {
    expect((await 开通.开通续费({ teamId, 时长: { months: 1 }, seats: 3, amount: 89.7, by: "测试" })).ok).toBe(true);
    await 都轮("li", "zhao", "boss");
    expect(await 手机轮("zhao-m")).toMatchObject({ ok: true });
    await 都轮("boss", "zhao");
    expect(await db("boss").customer.findUnique({ where: { id: "c-li-during-expiry" } })).toMatchObject({ name: "到期期间录的" });
    expect(await db("boss").followUp.count({ where: { content: "到期期间手机记的" } })).toBe(1);
    expect(await db("zhao").followUp.count({ where: { content: "到期期间手机记的" } })).toBe(1);
    const s = await 在团队的状态("boss");
    expect(s).toMatchObject({ active: true, 已到期: false, 席位: 3, lastError: null });
    expect(s.到期?.剩).toBeGreaterThanOrEqual(28);
  });
});

describe("7. 改名", () => {
  it("李在设置里改了名字（本机那一行 + 云端账号名）：同事、老板、成员名单、手机上都是新名字", async () => {
    const { 云端跟着改名 } = await import("@/lib/desktop/my-name");
    当("li");
    await db("li").user.update({ where: { id: A("li") }, data: { name: "李小明" } });
    expect(await 云端跟着改名(client.调云, "李小明")).toBe(true);
    await 都轮("li", "boss", "zhao");
    expect(await db("boss").user.findUnique({ where: { id: A("li") } })).toMatchObject({ name: "李小明" });
    expect(await db("zhao").user.findUnique({ where: { id: A("li") } })).toMatchObject({ name: "李小明" });
    expect((await 在团队的状态("boss")).成员.map((m) => m.name)).toEqual(["王老板", "李小明", "赵业务"]);
    expect(await 手机轮("zhao-m")).toMatchObject({ ok: true });
    expect(手机们["zhao-m"].库.表("User").find((u) => u.id === A("li"))?.name).toBe("李小明");
  });
});

describe("8. 移除同事 → 换钥匙；被移除的人收不到新数据", () => {
  it("老板在第二台电脑 boss2 上移除赵：钥匙换了；其余人照常收发", async () => {
    断网.add("zhao");
    await db("zhao").customer.update({ where: { id: "c-li-own" }, data: { remark: "赵被移除前断网改的" } });
    const 前 = 读配置("boss").epoch ?? 0;
    当("boss2");
    expect(await client.移除成员(账号.zhao)).toEqual({ ok: true, 跳过: 0 });
    expect(读配置("boss2").epoch).toBe(前 + 1);
    await db("boss").customer.create({ data: { id: "c-after-zhao", name: "移除赵之后老板录的", phone: "+8613900000010", salesOwnerId: A("li") } });
    await 都轮("boss", "boss2", "li", "li3", "boss", "li");
    expect(await db("li").customer.findUnique({ where: { id: "c-after-zhao" } })).toBeTruthy();
    expect(await db("boss2").customer.findUnique({ where: { id: "c-after-zhao" } })).toBeTruthy();
    expect(await 手机轮("boss-m")).toMatchObject({ ok: true });
    expect(手机客户("boss-m")).toContain("c-after-zhao");
    expect((await 在团队的状态("boss")).成员.map((m) => m.name)).toEqual(["王老板", "李小明"]);
    await 都干净("boss", "boss2", "li", "li3");
  });

  it("赵的电脑联网：同步说「不在团队里」，自动退出、只留他自己负责的；收不到移除之后的数据；断网时那笔没被当成「待核对」", async () => {
    断网.delete("zhao");
    const r = await 轮("zhao");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/不在这个团队/);
    await 等自动退出("zhao");
    expect(await db("zhao").customer.findUnique({ where: { id: "c-after-zhao" } })).toBeNull();
    // 他名下的（交接来的李的老客户）留着，不在他名下的公海、别人的都清掉
    expect(await 客户们("zhao")).toEqual(["c-li-own"]);
    当("zhao");
    expect(await client.团队状态()).toMatchObject({ 在团队: false });
    expect((await 列出范围冲突(db("zhao"))).length).toBe(0);
  });

  it("赵的手机：同步说清楚「不在团队里了」（手机据此清掉客户数据），不是让他去电脑上点「退出团队」", async () => {
    const x = await 手机轮("zhao-m");
    expect(x.ok).toBe(false);
    expect(!x.ok && x.error).toMatch(/不在这个团队/);
    expect(!x.ok && x.error).not.toMatch(/我的设备/);
  });
});

describe("9. 退出团队 / 重新加入", () => {
  it("李退出团队：他的电脑都退（li、li2、li3），只留自己负责的；老板那边一条不少", async () => {
    const 老板那边 = await 客户们("boss");
    当("li");
    expect(await client.退出团队()).toEqual({ ok: true });
    expect(await 客户们("li")).toEqual((await db("boss").customer.findMany({ where: { salesOwnerId: A("li") }, select: { id: true }, orderBy: { id: "asc" } })).map((c) => c.id));
    const r = await 轮("li3");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/不在这个团队/);
    await 等自动退出("li3");
    const r2 = await 轮("li2");
    expect(!r2.ok && r2.error).toMatch(/不在这个团队/);
    await 等自动退出("li2");
    await 都轮("boss");
    expect(await 客户们("boss")).toEqual(老板那边);
  });

  it("单干期间李又录了一位；老板换了个新邀请码给他，重新加入：单干期间录的也带进团队", async () => {
    await db("li").customer.create({ data: { id: "c-li-solo", name: "单干期间录的", phone: "+8613900000011", salesOwnerId: A("li") } });
    当("boss");
    const 新码 = await client.换邀请码();
    if (!新码.ok) throw Error(新码.error);
    // 旧码已作废
    当("li");
    expect(await client.加入团队(邀请码)).toMatchObject({ ok: false, error: expect.stringMatching(/作废/) });
    expect(await client.加入团队(新码.邀请码)).toMatchObject({ ok: true, teamName: "明亮贸易", active: true });
    await 都轮("li", "boss", "li");
    expect(await db("boss").customer.findUnique({ where: { id: "c-li-solo" } })).toMatchObject({ salesOwnerId: A("li") });
    expect(await db("li").customer.findUnique({ where: { id: "c-after-zhao" } })).toBeTruthy();
    expect((await 在团队的状态("li")).成员.map((m) => m.name)).toEqual(["王老板", "李小明"]);
    await 都干净("li", "boss");
  });
});

describe("10. 0.46.16 时建的单设备团队，升级到 0.46.17 后再加设备", () => {
  it("老团队：建团队那台登记设备时还没有「我的设备」记录（0.46.16 服务端没有这张表）", async () => {
    await db("old").customer.create({ data: { id: "c-old-1", name: "老团队的客户", phone: "+8613900000020", salesOwnerId: 模板.管理员 } });
    当("old");
    const r = await client.建团队("老团队");
    if (!r.ok) throw Error(r.error);
    const t = 读配置("old").teamId;
    await 开通.开通续费({ teamId: t, 时长: { months: 12 }, seats: 1, amount: null, by: "测试" });
    await 都轮("old");
    // 模拟 0.46.16：没有设备在用记录、.team.json 没记老板是谁
    await control.syncDeviceSeen.deleteMany({ where: { teamId: t } });
    const c = 读配置("old");
    delete c.ownerAccountId;
    client.写团队(c);
    await 都轮("old");
  });

  it("我的设备里认得出「这台」；新电脑配对连上后能管理团队，客户都过去了", async () => {
    当("old");
    const r = await 授权.我的设备();
    expect(r.ok && r.设备.map((d) => [d.种类, d.这台])).toEqual([["电脑", true]]);
    当("old2");
    expect((await 新机.发起连接()).ok).toBe(true);
    expect(await 电脑批("old")).toEqual({ ok: true });
    当("old2");
    expect(await 新机.查连接()).toMatchObject({ status: "joined" });
    await 都轮("old2", "old", "old2");
    expect(await 客户们("old2")).toEqual(["c-old-1"]);
    expect(client.能管理团队(读配置("old2"))).toBe(true);
    await 都干净("old", "old2");
  });
});
