/**
 * 手机连团队（授权）：手机申请 → 电脑领挑战、封好、允许 → 手机解开开始同步（2026-10-15，手机端方案 3.2）。
 * 和 mobile-sync 同一套台子（真实桌面端 + 真实中转），这里令牌是真签发的，接口按令牌认人，和 route.ts 一样。
 * 原 mobile-sync 文件头：手机端同步（lib/mobile/sync.ts）和真实桌面端一起跑（2026-10-15，手机端方案第 1 段「技术验证」）。
 * 老板、li、zhao 三台桌面端走真实 lib/sync/client.ts；li 的一台手机走 lib/mobile/sync.ts（浏览器版加密）；
 * 云端是真实的 sync-relay + sync-scoped（临时控制库）。手机登记设备这一步测试里直接调 入队（正式流程是电脑授权，见方案 3.2）。
 *
 * 验的是方案里答应用户的几件事：
 *   - 手机只拿得到本人 + 公海（老板私客拿不到），内容和电脑上一字不差
 *   - 手机记的跟进、新计划、完成旧计划，电脑（本人和老板）同步后看得到，时间、类型都对
 *   - 电脑上记的、改的，手机同步后看得到；客户转走了，手机上就没了
 *   - 断网时记的、推之前客户被转走：推上去被拒，进「被拒」，不悄悄丢
 *   - 老板移除成员换了钥匙：手机拿到封给自己的新钥匙，照样能收能推
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

type 谁 = "boss" | "li" | "zhao";
const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-mobile-link-"));
  for (const who of ["boss", "li", "zhao"]) {
    fs.mkdirSync(path.join(root, who), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(root, who, "crm.db"));
    if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(root, who, "crm.db-wal"));
  }
  return { root, 谁: "boss" as "boss" | "li" | "zhao" };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  const mk = (w: string) => new PrismaClient({ datasourceUrl: `file:${path.join(临时.root, w, "crm.db")}?connection_limit=1` });
  const dbs = { boss: mk("boss"), li: mk("li"), zhao: mk("zhao") };
  (globalThis as { __dbs?: typeof dbs }).__dbs = dbs;
  const prisma = new Proxy({}, { get: (_t, p) => { const db = dbs[临时.谁] as unknown as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(db) : v; } });
  return { prisma };
});

import type { PrismaClient } from "@/generated/prisma";
import type { 传输 } from "@/lib/sync/client";
import * as 手机 from "@/lib/mobile/sync";
import * as 连 from "@/lib/mobile/link";
import * as 授权 from "@/lib/sync/mobile-desktop";
import * as 密 from "@/lib/sync/crypto-web";

let client: typeof import("@/lib/sync/client");
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
let control: typeof import("@/lib/tenant/control").control;
let link: typeof import("@/lib/tenant/mobile-link");
let 令牌库: typeof import("@/lib/tenant/device-token");
/** 每台的令牌（真签发的）：桌面端按「当前是谁」，手机、攻击者各一枚 */
const 令牌: Record<string, string> = {};
const 账号: Record<谁, string> = { boss: "", li: "", zhao: "" };
const db = (w: 谁) => (globalThis as unknown as { __dbs: Record<string, PrismaClient> }).__dbs[w];
function 当(w: 谁) { 临时.谁 = w; process.env.CRM_DATA_DIR = path.join(临时.root, w); }
const A = (w: 谁) => `acct_${账号[w]}`;

/** 和云端说话：桌面端按「当前是谁」，手机固定是 li 的账号 */
async function 调中转(raw: string, 方法: string, 路径: string, body: unknown) {
  const t = await 令牌库.认领(raw);
  if (!t) return { 状态: 401, json: { error: "登录已失效，请重新登录" } };
  const a = t.accountId;
  const u = new URL(`http://x${路径}`);
  const b = (body ?? {}) as Record<string, unknown>;
  const 回 = (r: { ok: boolean; 状态?: number; error?: string }) => ({ 状态: r.ok ? 200 : (r.状态 ?? 500), json: r as unknown as Record<string, unknown> });
  if (u.pathname === "/api/sync/team" && 方法 === "GET") return { 状态: 200, json: { ok: true, teams: await relay.我的团队(a) } as Record<string, unknown> };
  if (u.pathname === "/api/sync/team") return 回(await relay.建团队(a, String(b.name), { device: String(b.device), pubKey: String(b.pubKey) }));
  if (u.pathname === "/api/sync/join") return 回(await relay.入队(a, String(b.teamId), String(b.joinSecret), { device: String(b.device), pubKey: String(b.pubKey) }));
  if (u.pathname === "/api/sync/key") return 回(await relay.取钥匙(a, u.searchParams.get("teamId")!, u.searchParams.get("device")!));
  if (u.pathname === "/api/sync/pull") return 回(await relay.给拉取(a, u.searchParams.get("teamId")!, Number(u.searchParams.get("after"))));
  if (u.pathname === "/api/sync/push") return 回(await relay.收推送(a, String(b.teamId), String(b.device), String(b.data)));
  if (u.pathname === "/api/sync/leave") return 回(await relay.退队(a, String(b.teamId)));
  if (u.pathname === "/api/sync/remove") return 回(await relay.移除成员(a, String(b.teamId), String(b.accountId)));
  if (u.pathname === "/api/sync/secret") return 回(await relay.换口令(a, String(b.teamId)));
  if (u.pathname === "/api/sync/devices") return 回(await relay.团队设备(a, u.searchParams.get("teamId")!));
  if (u.pathname === "/api/sync/rotate") return 回(await relay.换钥匙(a, String(b.teamId), Number(b.epoch), String(b.ring), b.envelopes as never));
  if (u.pathname === "/api/sync/scoped") {
    const t = String(b.teamId), act = String(b.action);
    try {
      if (act !== "state" && !(await scoped.范围开放(t))) return { 状态: 404, json: { error: "范围同步尚未开放" } };
      let r: unknown;
      if (act === "state") r = await scoped.范围状态(a, t);
      else if (act === "directory") r = await scoped.范围目录(a, t);
      else if (act === "begin") r = await scoped.开始范围迁移(a, t, String(b.device));
      else if (act === "commit") r = await scoped.完成范围迁移(a, t, String(b.device), Number(b.count));
      else if (act === "push") r = await scoped.收范围推送(a, t, String(b.device), b.packets as never[]);
      else r = await scoped.给范围拉取(a, t, String(b.scopeId), Number(b.after));
      return { 状态: 200, json: r as Record<string, unknown> };
    } catch (e) {
      if (e instanceof scoped.范围错误) return { 状态: e.状态, json: e.denied ? { error: e.message, denied: e.denied } : { error: e.message } };
      throw e;
    }
  }
  if (u.pathname === "/api/mobile/link") {
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    const act = b.action;
    if (act === "request") return 回(await link.申请(a, t.id, { device: b.device, pubKey: b.pubKey, label: b.label }));
    if (act === "status") return 回(await link.我的申请(a, t.id));
    if (act === "pending") return 回(await link.待授权(a) as never);
    if (act === "challenge") return 回(await link.挑战(a, s(b.id), s(b.teamId), s(b.device)));
    if (act === "approve") return 回(await link.允许(a, s(b.id), s(b.teamId), s(b.sealed), s(b.nonce)));
    if (act === "deny") return 回(await link.拒绝(a, s(b.id)));
    if (act === "list") return 回(await link.已连接(a) as never);
    if (act === "remove") return 回(await link.移除(a, s(b.id)));
  }
  return { 状态: 404, json: { error: `fake: ${路径}` } };
}
const 桌面传: 传输 = (方法, 路径, body) => 调中转(令牌[临时.谁], 方法, 路径, body);
/** JSON 来回一趟：真接口上 Date 变字符串，这里也一样 */
const 过线 = (x: { 状态: number; json: Record<string, unknown> }) => ({ 状态: x.状态, json: JSON.parse(JSON.stringify(x.json)) as Record<string, unknown> });
const 用令牌 = (名: string): 手机.传输 => async (方法, 路径, body) => 过线(await 调中转(令牌[名], 方法, 路径, body));

async function 清空(d: PrismaClient) {
  for (const t of ["AiMessage", "AiConversation", "AiProject", "Setting", "AuditLog", "ImportRow", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerClaim", "CustomerPool"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.user.create({ data: { id: "cmusc55660000dulko96ek8kr", email: "admin", name: "管理员", role: "ADMIN", password: "x", title: "管理员", createdAt: new Date("2026-10-01T00:00:00Z") } });
}
const 轮 = async (w: 谁) => { 当(w); return client.同步一轮(); };
const 都轮 = async (...ws: 谁[]) => { for (const w of ws) expect(await 轮(w)).toMatchObject({ ok: true }); };
const 全轮 = () => 都轮("li", "zhao", "boss", "li", "zhao");
const 读配置 = (w: 谁) => { 当(w); return client.读团队()!; };

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
  令牌库 = await import("@/lib/tenant/device-token");
  client = await import("@/lib/sync/client");
  for (const w of ["boss", "li", "zhao"] as const) {
    账号[w] = (await control.account.create({ data: { name: w, email: `${w}@example.invalid`, password: "not-a-login" } })).id;
    令牌[w] = (await 令牌库.签发(账号[w], `${w} 的电脑`)).token;
    fs.writeFileSync(path.join(临时.root, w, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: 令牌[w], accountId: 账号[w], name: w, contact: `${w}@example.invalid`, models: [], loggedAt: new Date().toISOString() }));
    await 清空(db(w));
  }
  // li 的手机、偷到 li 密码的人：各自用账号密码登录，拿到自己的令牌
  令牌.手机 = (await 令牌库.签发(账号.li, "手机 · iPhone")).token;
  令牌.贼甲 = (await 令牌库.签发(账号.li, "手机 · 贼")).token;
  令牌.贼乙 = (await 令牌库.签发(账号.li, "桌面端")).token;
  client.设传输(桌面传);
  当("boss");
  const 码 = await client.建团队("授权QA");
  if (!码.ok) throw Error(码.error);
  await relay.设开通(读配置("boss").teamId, true);
  await 都轮("boss");
  for (const w of ["li", "zhao"] as const) { 当(w); expect(await client.加入团队(码.邀请码)).toMatchObject({ ok: true }); }
  await 都轮("li", "zhao", "boss", "li", "zhao");
  await db("li").customer.create({ data: { id: "c-li", name: "Atlas Home Supplies", phone: "+14155550132", salesOwnerId: A("li") } });
  await db("li").followUp.create({ data: { id: "f-li-1", customerId: "c-li", ownerId: A("li"), type: "SMS", title: "", content: "样品周一到仓" } });
  await 全轮();
}, 180_000);
afterAll(async () => {
  client?.设传输(null);
  for (const w of ["boss", "li", "zhao"] as const) await db(w).$disconnect();
  await control?.$disconnect();
  for (const n of ["MULTI_TENANT", "DESKTOP_LOCAL", "SYNC_DIR", "CONTROL_DATABASE_URL", "CRM_DATA_DIR", "CRM_SCOPED_SYNC"]) delete process.env[n];
  fs.rmSync(临时.root, { recursive: true, force: true });
});

const 手机云 = 用令牌("手机");
let 手机钥: { 公钥: string; 私钥: CryptoKey };
const 手机设备 = 连.新设备号();
let 机: 手机.手机团队;
const 库 = new 手机.内存库();
const 状态 = 手机.新状态();

describe("手机连团队：申请 → 电脑授权 → 同步", () => {
  it("手机发申请；li 的电脑看到同一个配对数字；老板、zhao 的电脑看不到", async () => {
    手机钥 = await 密.设备钥匙对();
    expect(await 连.发申请(手机云, { device: 手机设备, pubKey: 手机钥.公钥, label: "iPhone · Safari" })).toMatchObject({ status: "pending" });
    // 重开页面再发一次：还是那一条
    const 再发 = await 连.发申请(手机云, { device: 手机设备, pubKey: 手机钥.公钥, label: "iPhone · Safari" });
    当("li");
    const p = await 授权.待授权手机();
    expect(p.ok && p.手机.length).toBe(1);
    expect(p.ok && p.手机[0]).toMatchObject({ id: 再发.id, label: "iPhone · Safari", 配对数字: await 密.配对数字(手机钥.公钥) });
    for (const w of ["boss", "zhao"] as const) { 当(w); const x = await 授权.待授权手机(); expect(x.ok && x.手机).toEqual([]); }
    expect(await 连.查申请(手机云, { device: 手机设备, 私钥: 手机钥.私钥 })).toEqual({ status: "pending" });
  });

  it("老板的电脑批不了 li 的手机（不同账号）", async () => {
    const id = (await 连.发申请(手机云, { device: 手机设备, pubKey: 手机钥.公钥, label: "iPhone · Safari" })).id;
    当("boss");
    expect(await 授权.允许手机(id)).toMatchObject({ ok: false });
  });

  it("偷到密码的人：自己装手机申请、再用另一枚令牌批——没有团队里那台电脑的私钥，批不了", async () => {
    const 贼钥 = await 密.设备钥匙对();
    const 贼甲 = 用令牌("贼甲"), 贼乙 = 用令牌("贼乙");
    const { id } = await 连.发申请(贼甲, { device: "m_thief_device_1", pubKey: 贼钥.公钥, label: "手机" });
    const teamId = 读配置("li").teamId;
    // 不领挑战直接批
    expect((await 贼乙("POST", "/api/mobile/link", { action: "approve", id, teamId, sealed: "x", nonce: "猜的" })).状态).toBe(403);
    // 冒用 li 那台电脑的设备号领挑战：领得到，但挑战是封给那台电脑公钥的，解不开，交不回正确的随机数
    const ch = await 贼乙("POST", "/api/mobile/link", { action: "challenge", id, teamId, device: 读配置("li").device });
    expect(ch.状态).toBe(200);
    expect((await 贼乙("POST", "/api/mobile/link", { action: "approve", id, teamId, sealed: "x", nonce: String(ch.json.challenge).slice(0, 43) })).状态).toBe(403);
    // 拿一个不在团队里的设备号、手机设备号领挑战：都不给
    expect((await 贼乙("POST", "/api/mobile/link", { action: "challenge", id, teamId, device: "desk_fake_1" })).状态).toBe(403);
    expect((await 贼乙("POST", "/api/mobile/link", { action: "challenge", id, teamId, device: "m_thief_device_1" })).状态).toBe(403);
    // 什么都没登记进团队
    expect(await control.syncDevice.findUnique({ where: { teamId_device: { teamId, device: "m_thief_device_1" } } })).toBeNull();
    expect(await 连.查申请(贼甲, { device: "m_thief_device_1", 私钥: 贼钥.私钥 })).toEqual({ status: "pending" });
    当("li");
    const p = await 授权.待授权手机();
    expect(p.ok && p.手机.map((x) => x.label).sort()).toEqual(["iPhone · Safari", "手机"]);
    // li 看到一条陌生申请（配对数字和自己手机上的对不上）：拒掉
    const 陌生 = p.ok ? p.手机.find((x) => x.label === "手机")! : null;
    expect(陌生!.配对数字).not.toBe(await 密.配对数字(手机钥.公钥));
    expect(await 授权.拒绝手机(陌生!.id)).toEqual({ ok: true });
    expect(await 连.查申请(贼甲, { device: "m_thief_device_1", 私钥: 贼钥.私钥 })).toEqual({ status: "denied" });
  });

  it("li 在电脑上允许：手机解开、核对是给自己的，开始同步，看得到 li 的客户", async () => {
    当("li");
    const p = await 授权.待授权手机();
    const 我的 = p.ok ? p.手机.find((x) => x.label === "iPhone · Safari")! : null;
    expect(await 授权.允许手机(我的!.id)).toEqual({ ok: true });
    const r = await 连.查申请(手机云, { device: 手机设备, 私钥: 手机钥.私钥 });
    expect(r.status).toBe("approved");
    if (r.status !== "approved") return;
    expect(r.teamName).toBe("授权QA");
    机 = r.团队;
    expect(机.userId).toBe(A("li"));
    const x = await 手机.同步一轮(机, 手机云, 库, 状态);
    机 = x.c;
    expect((await 库.取("Customer", "c-li"))?.r).toMatchObject({ name: "Atlas Home Supplies" });
    expect((await 库.取("FollowUp", "f-li-1"))?.r).toMatchObject({ content: "样品周一到仓" });
    // 电脑上「已连接的手机」里有它
    const 列 = await 授权.已连接手机();
    expect(列.ok && 列.手机.map((x) => x.label)).toEqual(["iPhone · Safari"]);
    // 授权过的不能再授权一次
    expect(await 授权.允许手机(我的!.id)).toMatchObject({ ok: false });
  });

  it("手机记的跟进，li 的电脑看得到", async () => {
    const { id } = await 手机.记跟进(机, 库, 状态, { customerId: "c-li", type: "PHONE", content: "授权后手机记的第一条" });
    机 = (await 手机.同步一轮(机, 手机云, 库, 状态)).c;
    await 都轮("li");
    expect(await db("li").followUp.findUnique({ where: { id } })).toMatchObject({ content: "授权后手机记的第一条" });
  });

  it("老板换钥匙：手机作为登记过的设备，照样收到封给自己的新钥匙", async () => {
    const 旧 = 机.epoch;
    当("boss");
    expect(await client.移除成员(账号.zhao)).toMatchObject({ ok: true });
    await 都轮("boss", "li");
    机 = (await 手机.同步一轮(机, 手机云, 库, 状态)).c;
    expect(机.epoch).toBeGreaterThan(旧);
  });

  it("在电脑上移除这台手机：令牌立刻作废、同步设备注销，手机再同步就是「登录已失效」；之后换钥匙不再封给它", async () => {
    当("li");
    const 列 = await 授权.已连接手机();
    const id = 列.ok ? 列.手机[0].id : "";
    expect(await 授权.移除手机(id)).toEqual({ ok: true });
    await expect(手机.同步一轮(机, 手机云, 库, 状态)).rejects.toThrow("登录已失效");
    expect(状态.lastError).toContain("登录已失效");
    const teamId = 读配置("li").teamId;
    expect(await control.syncDevice.findUnique({ where: { teamId_device: { teamId, device: 手机设备 } } })).toBeNull();
    const 列2 = await 授权.已连接手机();
    expect(列2.ok && 列2.手机).toEqual([]);
    // 老板再换一次钥匙（换邀请码）：信封里没有这台手机
    当("boss");
    const 换 = await client.换邀请码();
    expect(换, JSON.stringify(换)).toMatchObject({ ok: true });
    const 编号 = 读配置("boss").epoch!;
    expect(await control.syncKeyEnvelope.findUnique({ where: { teamId_epoch_device: { teamId, epoch: 编号, device: 手机设备 } } })).toBeNull();
  });
});

describe("申请并发安全", () => {
  it("同一枚令牌同时发两次申请：都成功、只有一条", async () => {
    const 名 = "并发";
    令牌[名] = (await 令牌库.签发(账号.li, "手机 · 并发")).token;
    const 云 = 用令牌(名);
    const 钥 = await 密.设备钥匙对();
    const [a, b] = await Promise.all([1, 2].map(() => 连.发申请(云, { device: "m_concurrent_1", pubKey: 钥.公钥, label: "并发" })));
    expect(a.id).toBe(b.id);
    expect(await control.syncMobileLink.count({ where: { device: "m_concurrent_1" } })).toBe(1);
  });
});

describe("手机上退出 / 换账号后，旧申请不再出现在电脑上", () => {
  it("发申请的令牌作废了：电脑上的待授权里没有它", async () => {
    令牌.退了 = (await 令牌库.签发(账号.li, "手机 · 退了")).token;
    const 钥 = await 密.设备钥匙对();
    await 连.发申请(用令牌("退了"), { device: "m_logged_out_1", pubKey: 钥.公钥, label: "退了的手机" });
    当("li");
    const 前 = await 授权.待授权手机();
    expect(前.ok && 前.手机.map((x) => x.label)).toContain("退了的手机");
    const t = await 令牌库.认领(令牌.退了);
    await 令牌库.吊销(t!.id, 账号.li);
    const 后 = await 授权.待授权手机();
    expect(后.ok && 后.手机.map((x) => x.label)).not.toContain("退了的手机");
  });
});
