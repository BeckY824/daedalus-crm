/**
 * 已连上的手机批准本人的新设备（2026-10-15，0.46.17）：手机批电脑、手机批手机、3 台上限、被移除的手机批不了、
 * 看不到别人账号的申请、老板的手机批的新电脑没有管理权限（签名钥匙不在手机上）、移除后换钥匙连口令一起换。
 * 台子照抄 sync-device-link.test.ts，手机走真实 lib/mobile/sync.ts + link.ts（浏览器版加密）。以下是那个文件的头：
 *
 * 团队版多设备同步（2026-10-15，~/Opensource_CRM/02-开发与发版/多设备同步-方案-20261015.md）：
 * 同一个账号的新电脑登录后认出团队 → 在本人另一台电脑上允许 → 新电脑解开开始同步；老板的签名钥匙随授权走；
 * 我的设备（列出、移除：令牌作废、设备注销、老板那台随后自动换钥匙）；每人最多 3 台。
 * 台子照抄 mobile-link.test.ts（真实桌面端 lib/sync/client.ts + 真实中转、令牌真签发），多两台：boss2、li2（同账号的第二台电脑）。
 * 以下是 mobile-link.test.ts 原文件头，台子说明仍然适用：
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

type 谁 = "boss" | "li" | "zhao" | "boss2" | "li2";
const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-mobile-approve-"));
  for (const who of ["boss", "li", "zhao", "boss2", "li2"]) {
    fs.mkdirSync(path.join(root, who), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(root, who, "crm.db"));
    if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(root, who, "crm.db-wal"));
  }
  return { root, 谁: "boss" as "boss" | "li" | "zhao" | "boss2" | "li2" };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  const mk = (w: string) => new PrismaClient({ datasourceUrl: `file:${path.join(临时.root, w, "crm.db")}?connection_limit=1` });
  const dbs = { boss: mk("boss"), li: mk("li"), zhao: mk("zhao"), boss2: mk("boss2"), li2: mk("li2") };
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

let client: typeof import("@/lib/sync/client");
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
let control: typeof import("@/lib/tenant/control").control;
let link: typeof import("@/lib/tenant/mobile-link");
let 令牌库: typeof import("@/lib/tenant/device-token");
let 我的: typeof import("@/lib/tenant/my-devices");
/** 每台的令牌（真签发的）：桌面端按「当前是谁」，手机、攻击者各一枚 */
const 令牌: Record<string, string> = {};
const 账号: Record<"boss" | "li" | "zhao", string> = { boss: "", li: "", zhao: "" };
/** 同账号的第二台：用谁的账号 */
const 账号的: Record<谁, "boss" | "li" | "zhao"> = { boss: "boss", li: "li", zhao: "zhao", boss2: "boss", li2: "li" };
const db = (w: 谁) => (globalThis as unknown as { __dbs: Record<string, PrismaClient> }).__dbs[w];
function 当(w: 谁) { 临时.谁 = w; process.env.CRM_DATA_DIR = path.join(临时.root, w); }
const A = (w: 谁) => `acct_${账号[账号的[w]]}`;

/** 和云端说话：桌面端按「当前是谁」，手机固定是 li 的账号 */
async function 调中转(raw: string, 方法: string, 路径: string, body: unknown) {
  const tk = await 令牌库.认领(raw);
  if (!tk) return { 状态: 401, json: { error: "登录已失效，请重新登录" } };
  const t = tk;
  const a = t.accountId;
  const u = new URL(`http://x${路径}`);
  const b = (body ?? {}) as Record<string, unknown>;
  const 回 = (r: { ok: boolean; 状态?: number; error?: string }) => ({ 状态: r.ok ? 200 : (r.状态 ?? 500), json: r as unknown as Record<string, unknown> });
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
      // 和 route.ts 一样：带设备号的先核（被移除的挡下）、记最近同步
      if (act === "directory" || act === "pull" || act === "push") await scoped.核设备(a, t, b.device, tk.id);
      let r: unknown;
      if (act === "state") r = await scoped.范围状态(a, t);
      else if (act === "directory") r = await scoped.范围目录(a, t);
      else if (act === "begin") r = await scoped.开始范围迁移(a, t, String(b.device));
      else if (act === "commit") r = await scoped.完成范围迁移(a, t, String(b.device), Number(b.count));
      else if (act === "push") r = await scoped.收范围推送(a, t, String(b.device), b.packets as never[]);
      else if (act === "pull-many") r = await scoped.给多个范围拉取(a, t, b.scopes);
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
/** JSON 来回一趟：真接口上 Date 变字符串，这里也一样 */
const 过线 = (x: { 状态: number; json: Record<string, unknown> }) => ({ 状态: x.状态, json: JSON.parse(JSON.stringify(x.json)) as Record<string, unknown> });
const 桌面传: 传输 = async (方法, 路径, body) => 过线(await 调中转(令牌[临时.谁], 方法, 路径, body));
const 用令牌 = (名: string): 手机.传输 => async (方法, 路径, body) => 过线(await 调中转(令牌[名], 方法, 路径, body));

async function 清空(d: PrismaClient) {
  for (const t of ["AiMessage", "AiConversation", "AiProject", "Setting", "AuditLog", "ImportRow", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerClaim", "CustomerPool"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.user.create({ data: { id: "cmusc55660000dulko96ek8kr", email: "admin", name: "管理员", role: "ADMIN", password: "x", title: "管理员", createdAt: new Date("2026-10-01T00:00:00Z") } });
}
const 轮 = async (w: 谁) => { 当(w); return client.同步一轮(); };
/** 一轮跑完再等「老板补换钥匙」那一下（同步一轮结束后后台跑的）落地 */
const 等后台 = () => new Promise((r) => setTimeout(r, 50));
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
  我的 = await import("@/lib/tenant/my-devices");
  令牌库 = await import("@/lib/tenant/device-token");
  client = await import("@/lib/sync/client");
  for (const w of ["boss", "li", "zhao"] as const) 账号[w] = (await control.account.create({ data: { name: w, email: `${w}@example.invalid`, password: "not-a-login" } })).id;
  for (const w of ["boss", "li", "zhao", "boss2", "li2"] as const) {
    const 号 = 账号[账号的[w]];
    令牌[w] = (await 令牌库.签发(号, `${w}-机器`)).token;
    fs.writeFileSync(path.join(临时.root, w, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: 令牌[w], accountId: 号, name: 账号的[w], contact: `${账号的[w]}@example.invalid`, models: [], loggedAt: new Date().toISOString() }));
    await 清空(db(w));
  }
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
  当("boss");
  await db("boss").customer.create({ data: { id: "c-boss", name: "老板自己的客户", phone: "+8613900000001", salesOwnerId: A("boss") } });
  await 全轮();
}, 180_000);
afterAll(async () => {
  client?.设传输(null);
  for (const w of ["boss", "li", "zhao", "boss2", "li2"] as const) await db(w).$disconnect();
  await control?.$disconnect();
  for (const n of ["MULTI_TENANT", "DESKTOP_LOCAL", "SYNC_DIR", "CONTROL_DATABASE_URL", "CRM_DATA_DIR", "CRM_SCOPED_SYNC"]) delete process.env[n];
  fs.rmSync(临时.root, { recursive: true, force: true });
});

const teamId = () => 读配置("boss").teamId;

/** 一台手机：登录（签令牌）→ 生成钥匙对 → 发申请。返回批准后用得上的东西 */
async function 新手机(名: string, 谁的: "boss" | "li" | "zhao") {
  令牌[名] = (await 令牌库.签发(账号[谁的], `手机 · ${名}`)).token;
  const 钥 = await 密.设备钥匙对();
  const device = 连.新设备号();
  const 云 = 用令牌(名);
  const 申 = await 云("POST", "/api/mobile/link", { action: "request", device, pubKey: 钥.公钥, label: `iPhone · ${名}` });
  return { 名, 云, device, 钥, 申, 库: new 手机.内存库(), 态: 手机.新状态(), 团: null as 手机.手机团队 | null };
}
type 机 = Awaited<ReturnType<typeof 新手机>>;
async function 收下(p: 机) {
  const r = await 连.查申请(p.云, { device: p.device, 私钥: p.钥.私钥 });
  expect(r.status).toBe("approved");
  if (r.status !== "approved") throw Error("没批");
  p.团 = r.团队;
  p.团 = (await 手机.同步一轮(p.团, p.云, p.库, p.态)).c;
  return r;
}
/** 电脑上批这台手机（用电脑的 允许手机） */
async function 电脑批(w: 谁, label: string) {
  当(w);
  const p = await 授权.待授权手机();
  const x = p.ok ? p.手机.find((q) => q.label === label) : undefined;
  expect(x, label).toBeTruthy();
  expect(await 授权.允许手机(x!.id)).toEqual({ ok: true });
}

let 李手机: 机, 老板手机: 机;

describe("已连上的手机批准本人的新设备", () => {
  it("li 的电脑先批一台手机；手机同步下来 li 的客户", async () => {
    李手机 = await 新手机("li-p1", "li");
    expect(李手机.申.状态).toBe(200);
    await 电脑批("li", "iPhone · li-p1");
    const r = await 收下(李手机);
    expect(r.teamName).toBe("授权QA");
    expect((await 李手机.库.取("Customer", "c-li"))?.r).toMatchObject({ name: "Atlas Home Supplies" });
  });

  it("li2（新电脑）发申请：手机上看得到、配对数字一致；老板的新电脑发的申请 li 的手机看不到", async () => {
    当("li2");
    const r = await 新机.发起连接();
    expect(r.ok).toBe(true);
    当("boss2");
    expect((await 新机.发起连接()).ok).toBe(true);
    const 列 = await 连.待授权的(李手机.云);
    expect(列.length).toBe(1);
    expect(列[0]).toMatchObject({ 电脑: true, 配对数字: r.ok ? r.配对数字 : "" });
    // 老板的手机（另一个账号）也看不到 li 的
    老板手机 = await 新手机("boss-p1", "boss");
    await 电脑批("boss", "iPhone · boss-p1");
    await 收下(老板手机);
    const 老板看 = await 连.待授权的(老板手机.云);
    expect(老板看.map((x) => x.电脑)).toEqual([true]);
    expect(老板看[0].id).not.toBe(列[0].id);
    // 老板的手机去批 li 的申请：不行（按账号核）
    await expect(连.允许设备(老板手机.云, 老板手机.团!, "授权QA", 列[0].id)).rejects.toThrow();
  });

  it("li 的手机批准 li2：li2 连上、能同步；没有签名私钥、没有入队口令，邀请码不显示", async () => {
    const [x] = await 连.待授权的(李手机.云);
    await 连.允许设备(李手机.云, 李手机.团!, "授权QA", x.id);
    当("li2");
    expect(await 新机.查连接()).toEqual({ ok: true, status: "joined", teamName: "授权QA" });
    const c = 读配置("li2");
    expect(c.signPriv).toBeUndefined();
    expect(c.joinSecret).toBe("");
    expect(c.signPub).toBe(读配置("boss").signPub);
    await 都轮("li2");
    expect(await db("li2").customer.findUnique({ where: { id: "c-li" } })).toMatchObject({ name: "Atlas Home Supplies" });
    当("li2");
    const s = await client.团队状态();
    expect(s.在团队 && s.邀请码).toBe("");
    // 两边互通：li2 记一笔，手机收到
    await db("li2").followUp.create({ data: { id: "f-li2-p", customerId: "c-li", ownerId: A("li2"), type: "PHONE", title: "", content: "手机批准的电脑记的" } });
    await 都轮("li2");
    李手机.团 = (await 手机.同步一轮(李手机.团!, 李手机.云, 李手机.库, 李手机.态)).c;
    expect((await 李手机.库.取("FollowUp", "f-li2-p"))?.r).toMatchObject({ content: "手机批准的电脑记的" });
  });

  it("老板的手机批准 boss2：能同步全队，但管不了团队（签名钥匙不在手机上）", async () => {
    const [x] = await 连.待授权的(老板手机.云);
    await 连.允许设备(老板手机.云, 老板手机.团!, "授权QA", x.id);
    当("boss2");
    expect(await 新机.查连接()).toMatchObject({ ok: true, status: "joined" });
    const c = 读配置("boss2");
    expect(c.signPriv).toBeUndefined();
    expect(client.能管理团队(c)).toBe(false);
    await 都轮("boss2");
    expect(await db("boss2").customer.findUnique({ where: { id: "c-boss" } })).toMatchObject({ name: "老板自己的客户" });
    当("boss2");
    expect(await client.换邀请码()).toMatchObject({ ok: false });
  });

  it("满 3 台：li 已有电脑、手机、li2，第 4 台手机发申请就说满了；在电脑上移除 li2 后，手机批准新手机", async () => {
    const p2 = await 新手机("li-p2", "li");
    expect(p2.申.状态).toBe(409);
    expect(String(p2.申.json.error)).toContain("最多 3 台");
    const li2 = 读配置("li2").device;
    当("li");
    expect(await 授权.移除设备(li2)).toEqual({ ok: true });
    const 再 = await p2.云("POST", "/api/mobile/link", { action: "request", device: p2.device, pubKey: p2.钥.公钥, label: "iPhone · li-p2" });
    expect(再.状态).toBe(200);
    const 列 = await 连.待授权的(李手机.云);
    const x = 列.find((q) => q.label === "iPhone · li-p2")!;
    expect(x).toMatchObject({ 电脑: false, 配对数字: await 密.配对数字(p2.钥.公钥) });
    await 连.允许设备(李手机.云, 李手机.团!, "授权QA", x.id);
    await 收下(p2);
    expect((await p2.库.取("Customer", "c-li"))?.r).toMatchObject({ name: "Atlas Home Supplies" });
    // 手机上的「我的设备」：电脑、两台手机
    const 我 = await 连.我的设备(李手机.云, 李手机.团!);
    expect(我.上限).toBe(3);
    expect(我.设备.map((d) => d.种类).sort()).toEqual(["手机", "手机", "电脑"]);
    expect(我.设备.filter((d) => d.这台).map((d) => d.device)).toEqual([李手机.device]);
  });

  it("被移除的手机批不了：令牌作废，连待授权都看不到；拿别的令牌冒用它的设备号领挑战也不行", async () => {
    当("li");
    expect(await 授权.移除设备(李手机.device)).toEqual({ ok: true });
    await expect(连.待授权的(李手机.云)).rejects.toThrow(/登录已失效/);
    // li 的新令牌（偷到密码的人）+ 被移除手机的设备号：设备已注销，领不到挑战
    令牌.贼 = (await 令牌库.签发(账号.li, "手机 · 贼")).token;
    // li2 上一步被移除了（令牌作废，用户重新登录），本机还留着团队设置：先退出（只清这台，不牵连 li 的账号），再发申请
    令牌.li2 = (await 令牌库.签发(账号.li, "li2-机器")).token;
    const 团 = teamId();
    当("li2");
    expect(await client.退出团队()).toMatchObject({ ok: true });
    expect(await relay.在队里(团, 账号.li)).toBeTruthy();
    当("li2");
    expect((await 新机.发起连接()).ok).toBe(true);
    const 贼 = 用令牌("贼");
    const [x] = await 连.待授权的(贼);
    const ch = await 贼("POST", "/api/mobile/link", { action: "challenge", id: x.id, teamId: 团, device: 李手机.device });
    expect(ch.状态).toBe(403);
    // 自己批自己：拿申请那台的设备号领挑战，也不行
    const 自 = await 贼("POST", "/api/mobile/link", { action: "challenge", id: x.id, teamId: 团, device: x.device });
    expect(自.状态).toBe(403);
  });

  it("移除设备后老板那台换钥匙：入队口令一起换，旧口令进不来", async () => {
    当("boss");
    const 旧口令 = 读配置("boss").joinSecret;
    expect(await client.老板补换钥匙(true)).toMatchObject({ ok: true, 换了: true });
    const 新 = 读配置("boss");
    expect(新.joinSecret).not.toBe(旧口令);
    const 生人 = (await control.account.create({ data: { name: "生人", email: "stranger@example.invalid", password: "x" } })).id;
    expect(await relay.入队(生人, 新.teamId, 旧口令, { device: "d000000000001", pubKey: (await import("@/lib/sync/crypto")).设备钥匙对().公钥 })).toMatchObject({ ok: false });
  });
});
