/**
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

type 谁 = "boss" | "li" | "zhao" | "boss2" | "li2" | "li3";
const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-device-link-"));
  for (const who of ["boss", "li", "zhao", "boss2", "li2", "li3"]) {
    fs.mkdirSync(path.join(root, who), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(root, who, "crm.db"));
    if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(root, who, "crm.db-wal"));
  }
  return { root, 谁: "boss" as "boss" | "li" | "zhao" | "boss2" | "li2" | "li3" };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  const mk = (w: string) => new PrismaClient({ datasourceUrl: `file:${path.join(临时.root, w, "crm.db")}?connection_limit=1` });
  const dbs = { boss: mk("boss"), li: mk("li"), zhao: mk("zhao"), boss2: mk("boss2"), li2: mk("li2"), li3: mk("li3") };
  (globalThis as { __dbs?: typeof dbs }).__dbs = dbs;
  const prisma = new Proxy({}, { get: (_t, p) => { const db = dbs[临时.谁] as unknown as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(db) : v; } });
  return { prisma };
});

import type { PrismaClient } from "@/generated/prisma";
import type { 传输 } from "@/lib/sync/client";
import * as 授权 from "@/lib/sync/mobile-desktop";
import * as 新机 from "@/lib/sync/device-link";
import * as 密 from "@/lib/sync/crypto-web";

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
const 账号的: Record<谁, "boss" | "li" | "zhao"> = { boss: "boss", li: "li", zhao: "zhao", boss2: "boss", li2: "li", li3: "li" };
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
  for (const w of ["boss", "li", "zhao", "boss2", "li2", "li3"] as const) {
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
  for (const w of ["boss", "li", "zhao", "boss2", "li2", "li3"] as const) await db(w).$disconnect();
  await control?.$disconnect();
  for (const n of ["MULTI_TENANT", "DESKTOP_LOCAL", "SYNC_DIR", "CONTROL_DATABASE_URL", "CRM_DATA_DIR", "CRM_SCOPED_SYNC"]) delete process.env[n];
  fs.rmSync(临时.root, { recursive: true, force: true });
});

const teamId = () => 读配置("boss").teamId;
const 设备行 = (device: string) => control.syncDevice.findUnique({ where: { teamId_device: { teamId: teamId(), device } } });

describe("新电脑登录同一个账号：认出团队 → 在另一台电脑上允许 → 开始同步", () => {
  it("li2 还没连上：认得出账号在哪个团队里，本机客户数也报出来", async () => {
    当("li2");
    await db("li2").customer.create({ data: { id: "c-li2-old", name: "li2 以前自己录的", phone: "+8613900000222", salesOwnerId: "cmusc55660000dulko96ek8kr" } });
    const x = await 新机.连接概况();
    expect(x.云上的团).toMatchObject({ name: "授权QA", 我是建的人: false });
    expect(x.等授权).toBeNull();
    expect(x.本机客户).toBe(1);
  });

  it("li2 发申请：li 的电脑弹出「电脑」申请、配对数字一致；老板、zhao 看不到；老板批不了", async () => {
    当("li2");
    const r = await 新机.发起连接();
    expect(r.ok).toBe(true);
    const 数字 = r.ok ? r.配对数字 : "";
    // 再点一次：沿用同一对钥匙，数字不变
    const r2 = await 新机.发起连接();
    expect(r2.ok && r2.配对数字).toBe(数字);
    expect((await 新机.连接概况()).等授权).toEqual({ 配对数字: 数字 });
    当("li");
    const p = await 授权.待授权手机();
    expect(p.ok && p.手机.length).toBe(1);
    expect(p.ok && p.手机[0]).toMatchObject({ label: expect.stringContaining("（"), 电脑: true, 配对数字: 数字 });
    for (const w of ["boss", "zhao"] as const) { 当(w); const q = await 授权.待授权手机(); expect(q.ok && q.手机).toEqual([]); }
    当("boss");
    expect(await 授权.允许手机(p.ok ? p.手机[0].id : "")).toMatchObject({ ok: false });
    当("li2");
    expect(await 新机.查连接()).toEqual({ ok: true, status: "pending" });
  });

  it("li 点允许：li2 解开、连上，是业务员（没有签名私钥），本机先备份；同步后有 li 的客户、没有老板的私客", async () => {
    当("li");
    const p = await 授权.待授权手机();
    expect(await 授权.允许手机(p.ok ? p.手机[0].id : "")).toEqual({ ok: true });
    当("li2");
    expect(await 新机.查连接()).toEqual({ ok: true, status: "joined", teamName: "授权QA" });
    const c = 读配置("li2");
    expect(c.teamId).toBe(teamId());
    expect(c.signPriv).toBeUndefined();
    expect(c.signPub).toBe(读配置("boss").signPub);
    expect(c.joinSecret).toBe(读配置("li").joinSecret);
    expect(c.ownerAccountId).toBe(账号.boss);
    expect(fs.existsSync(path.join(临时.root, "li2", ".team-link.json"))).toBe(false);
    expect(fs.readdirSync(path.join(临时.root, "li2", "backups")).some((f) => f.startsWith("before-device-link-"))).toBe(true);
    expect((await 设备行(c.device))?.accountId).toBe(账号.li);
    await 都轮("li2", "li", "boss", "li2");
    当("li2");
    expect(await db("li2").customer.findUnique({ where: { id: "c-li" } })).toMatchObject({ name: "Atlas Home Supplies" });
    expect(await db("li2").followUp.findUnique({ where: { id: "f-li-1" } })).toMatchObject({ content: "样品周一到仓" });
    expect(await db("li2").customer.findUnique({ where: { id: "c-boss" } })).toBeNull();
    // 这台以前自己录的客户带进了团队：li、老板都看得到
    expect(await db("li").customer.findUnique({ where: { id: "c-li2-old" } })).toMatchObject({ name: "li2 以前自己录的" });
    expect(await db("boss").customer.findUnique({ where: { id: "c-li2-old" } })).toMatchObject({ salesOwnerId: A("li") });
  });

  it("两台之间双向同步：li2 记一笔 li 看得到，li 改一笔 li2 看得到", async () => {
    当("li2");
    await db("li2").followUp.create({ data: { id: "f-li2-1", customerId: "c-li", ownerId: A("li2"), type: "PHONE", title: "", content: "在公司电脑上记的" } });
    await 都轮("li2", "li");
    expect(await db("li").followUp.findUnique({ where: { id: "f-li2-1" } })).toMatchObject({ content: "在公司电脑上记的" });
    当("li");
    await db("li").customer.update({ where: { id: "c-li" }, data: { name: "Atlas Home Supplies Ltd" } });
    await 都轮("li", "li2");
    expect(await db("li2").customer.findUnique({ where: { id: "c-li" } })).toMatchObject({ name: "Atlas Home Supplies Ltd" });
  });

  it("老板的第二台：老板那台允许后，签名私钥一起过来，boss2 能换邀请码、同事收得下新钥匙", async () => {
    当("boss2");
    const r = await 新机.发起连接();
    expect(r.ok).toBe(true);
    当("boss");
    const p = await 授权.待授权手机();
    expect(await 授权.允许手机(p.ok ? p.手机[0].id : "")).toEqual({ ok: true });
    当("boss2");
    expect(await 新机.查连接()).toMatchObject({ ok: true, status: "joined" });
    const c = 读配置("boss2");
    expect(c.signPriv).toBe(读配置("boss").signPriv);
    expect(client.能管理团队(c)).toBe(true);
    await 都轮("boss2");
    expect(await db("boss2").customer.findUnique({ where: { id: "c-boss" } })).toMatchObject({ name: "老板自己的客户" });
    const 旧编号 = 读配置("li").epoch ?? 0;
    当("boss2");
    expect(await client.换邀请码()).toMatchObject({ ok: true });
    await 都轮("li", "li2", "zhao", "boss");
    for (const w of ["li", "li2", "zhao", "boss"] as const) expect(读配置(w).epoch, w).toBeGreaterThan(旧编号);
    expect(读配置("li").lastError ?? null).toBeNull();
  });
});

describe("我的设备", () => {
  it("li 看得到自己的两台电脑（名字是登录时的机器名）、标出「这台」；看不到别人的", async () => {
    当("li");
    const r = await 授权.我的设备();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.上限).toBe(3);
    expect(r.设备.map((d) => [d.label, d.种类, d.这台]).sort()).toEqual([["li-机器", "电脑", true], ["li2-机器", "电脑", false]]);
    expect(r.设备.every((d) => d.最近同步)).toBe(true);
  });

  it("每人最多 3 台：第 3 台能申请，第 4 台发申请时就说满了", async () => {
    令牌.li3 = (await 令牌库.签发(账号.li, "li3-机器")).token;
    令牌.li4 = (await 令牌库.签发(账号.li, "li4-机器")).token;
    const 钥3 = await 密.设备钥匙对(), 钥4 = await 密.设备钥匙对();
    const 发 = (名: string, device: string, pubKey: string) => 调中转(令牌[名], "POST", "/api/mobile/link", { action: "request", device, pubKey, label: 名 });
    // 先登记第 3 台（直接走授权：li 批）
    expect((await 发("li3", "d333333333333", 钥3.公钥)).状态).toBe(200);
    当("li");
    const p = await 授权.待授权手机();
    expect(await 授权.允许手机(p.ok ? p.手机.find((x) => x.label === "li3")!.id : "")).toEqual({ ok: true });
    const 满 = await 发("li4", "d444444444444", 钥4.公钥);
    expect(满.状态).toBe(409);
    expect(String(满.json.error)).toContain("最多 3 台");
    // 已经登记的不受影响：li2 照常同步
    await 都轮("li2");
    // 又一台新电脑（li3 那个目录）打开时自动发申请（首页弹框，components/TeamConnectPrompt）：当场说满了，本机不留半路的申请
    当("li3");
    expect((await 新机.连接概况()).云上的团).toMatchObject({ name: "授权QA" });
    const 满了 = await 新机.发起连接();
    expect(满了.ok).toBe(false);
    expect(!满了.ok && 满了.error).toContain("最多 3 台");
    expect((await 新机.连接概况()).等授权).toBeNull();
    expect(fs.existsSync(path.join(临时.root, "li3", ".team-link.json"))).toBe(false);
  });

  it("移除正在用的这台不行；移除 li3：令牌作废、设备注销，老板那台下一轮自动换钥匙，新钥匙不再封给它", async () => {
    // 读配置 会切到那一台：先把要用的都读出来，再切回 li
    const 前 = 读配置("boss").epoch ?? 0;
    const 团 = teamId(), li设备 = 读配置("li").device;
    当("li");
    expect(await 授权.移除设备(li设备)).toMatchObject({ ok: false });
    // 绕过本机那一道、直接拿这台的令牌去移除自己：服务端也不让
    const 自己 = await 调中转(令牌.li, "POST", "/api/sync/my-devices", { action: "remove", teamId: 团, device: li设备 });
    expect(自己.状态).toBe(400);
    expect(await 授权.移除设备("d333333333333")).toEqual({ ok: true });
    expect(await 设备行("d333333333333")).toBeNull();
    expect(await 令牌库.认领(令牌.li3)).toBeNull();
    expect((await relay.我的团队(账号.boss))[0]).toMatchObject({ 要换钥匙: true });
    // 老板那台：同步一轮之后自己换（测试里直接叫强制版，免得等五分钟的节流）
    当("boss");
    expect(await client.老板补换钥匙(true)).toEqual({ ok: true, 换了: true });
    expect(读配置("boss").epoch).toBe(前 + 1);
    expect(await control.syncKeyEnvelope.findUnique({ where: { teamId_epoch_device: { teamId: teamId(), epoch: 前 + 1, device: "d333333333333" } } })).toBeNull();
    expect((await relay.我的团队(账号.boss))[0].要换钥匙).toBeUndefined();
    // 再问一次：不重复换
    expect(await client.老板补换钥匙(true)).toEqual({ ok: true, 换了: false });
    await 都轮("li", "li2", "zhao", "boss2");
    for (const w of ["li", "li2", "zhao", "boss2"] as const) expect(读配置(w).epoch, w).toBe(前 + 1);
  });

  it("li 移除 li2：li2 马上退出登录；用同一个账号重新登录，拿着旧的团队配置也拉不到（设备号对不上）", async () => {
    const li2 = 读配置("li2").device, 团 = teamId();
    当("li");
    expect(await 授权.移除设备(li2)).toEqual({ ok: true });
    expect(await 轮("li2")).toMatchObject({ ok: false, error: expect.stringContaining("登录已失效") });
    // 重新登录（新令牌），.team.json 还在
    令牌.li2 = (await 令牌库.签发(账号.li, "li2-机器")).token;
    当("li2");
    const r = await client.同步一轮();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/移除|设备身份不符/);
    // 直接拿设备号去拉：服务端挡下
    const d = await 调中转(令牌.li2, "POST", "/api/sync/scoped", { teamId: 团, action: "directory", device: li2 });
    expect(d.状态).toBe(403);
    expect(String(d.json.error)).toContain("移除");
  });

  it("被移除的 li2 重新登录后点退出团队：只清这台，不把 li 整个账号踢出去", async () => {
    当("li2");
    expect(await client.退出团队()).toMatchObject({ ok: true });
    expect(await relay.在队里(teamId(), 账号.li)).toBeTruthy();
    await 都轮("li");
  });

  it("被拒之后还能再申请（电脑的令牌不会换）：同一枚令牌那条重新挂成待授权", async () => {
    当("li2");
    const r = await 新机.发起连接();
    expect(r.ok).toBe(true);
    当("li");
    let p = await 授权.待授权手机();
    expect(await 授权.拒绝手机(p.ok ? p.手机[0].id : "")).toEqual({ ok: true });
    当("li2");
    expect(await 新机.查连接()).toEqual({ ok: true, status: "denied" });
    expect((await 新机.发起连接()).ok).toBe(true);
    expect(await 新机.查连接()).toEqual({ ok: true, status: "pending" });
    当("li");
    p = await 授权.待授权手机();
    expect(p.ok && p.手机.length).toBe(1);
    expect(await 授权.允许手机(p.ok ? p.手机[0].id : "")).toEqual({ ok: true });
    当("li2");
    expect(await 新机.查连接()).toMatchObject({ ok: true, status: "joined" });
    await 都轮("li2");
    expect(await db("li2").followUp.findUnique({ where: { id: "f-li2-1" } })).toMatchObject({ content: "在公司电脑上记的" });
  });

  it("手机移除后同样记「该换钥匙」（原来移除手机不换）", async () => {
    // 上一步移除 li2 留下的「该换钥匙」先让老板那台换掉
    当("boss");
    await client.老板补换钥匙(true);
    expect((await relay.我的团队(账号.boss))[0].要换钥匙).toBeUndefined();
    const 钥 = await 密.设备钥匙对();
    令牌.li手机 = (await 令牌库.签发(账号.li, "手机 · iPhone")).token;
    // li 现在两台电脑 + 0 手机：手机能申请
    const 申 = await 调中转(令牌.li手机, "POST", "/api/mobile/link", { action: "request", device: "m_phone_for_rekey", pubKey: 钥.公钥, label: "iPhone · Safari" });
    expect(申.状态).toBe(200);
    当("li");
    const p = await 授权.待授权手机();
    const x = p.ok ? p.手机.find((q) => !q.电脑)! : null;
    expect(x).toBeTruthy();
    expect(await 授权.允许手机(x!.id)).toEqual({ ok: true });
    const 设 = await 授权.我的设备();
    expect(设.ok && 设.设备.map((d) => d.种类).sort()).toEqual(["手机", "电脑", "电脑"]);
    expect(await 授权.移除设备("m_phone_for_rekey")).toEqual({ ok: true });
    expect((await relay.我的团队(账号.boss))[0]).toMatchObject({ 要换钥匙: true });
    当("boss");
    expect(await client.老板补换钥匙(true)).toMatchObject({ ok: true, 换了: true });
    await 等后台();
  });

  it("两台都在用时，li2 退出团队：整个账号退出，li 那台也一起停（设备跟账号走，10-15 你定）", async () => {
    const 团 = teamId();
    当("li2");
    expect(await client.退出团队()).toMatchObject({ ok: true });
    expect(client.读团队()).toBeNull();
    expect(await relay.在队里(团, 账号.li)).toBeNull();
    expect(await control.syncDevice.count({ where: { teamId: 团, accountId: 账号.li } })).toBe(0);
    expect(await 轮("li")).toMatchObject({ ok: false });
    // 退出的那台只留 li 自己的客户（业务员走时的老规矩）
    expect(await db("li2").customer.findUnique({ where: { id: "c-li" } })).toBeTruthy();
  });
});
