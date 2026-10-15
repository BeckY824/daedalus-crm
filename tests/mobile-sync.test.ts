/**
 * 手机端同步（lib/mobile/sync.ts）和真实桌面端一起跑（2026-10-15，手机端方案第 1 段「技术验证」）。
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-mobile-sync-"));
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
import * as 密 from "@/lib/sync/crypto-web";

let client: typeof import("@/lib/sync/client");
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
let control: typeof import("@/lib/tenant/control").control;
const 账号: Record<谁, string> = { boss: "", li: "", zhao: "" };
const db = (w: 谁) => (globalThis as unknown as { __dbs: Record<string, PrismaClient> }).__dbs[w];
function 当(w: 谁) { 临时.谁 = w; process.env.CRM_DATA_DIR = path.join(临时.root, w); }
const A = (w: 谁) => `acct_${账号[w]}`;

/** 和云端说话：桌面端按「当前是谁」，手机固定是 li 的账号 */
async function 调中转(a: string, 方法: string, 路径: string, body: unknown) {
  const u = new URL(`http://x${路径}`);
  const b = (body ?? {}) as Record<string, unknown>;
  const 回 = (r: { ok: boolean; 状态?: number; error?: string }) => ({ 状态: r.ok ? 200 : (r.状态 ?? 500), json: r as unknown as Record<string, unknown> });
  if (u.pathname === "/api/sync/team" && 方法 === "GET") return { 状态: 200, json: { ok: true, teams: await relay.我的团队(a) } as Record<string, unknown> };
  if (u.pathname === "/api/sync/team") return 回(await relay.建团队(a, String(b.name), { device: String(b.device), pubKey: String(b.pubKey) }));
  if (u.pathname === "/api/sync/join") return 回(await relay.入队(a, String(b.teamId), String(b.joinSecret), { device: String(b.device), pubKey: String(b.pubKey) }));
  if (u.pathname === "/api/sync/key") return 回(await relay.取钥匙(a, u.searchParams.get("teamId")!, u.searchParams.get("device")!));
  if (u.pathname === "/api/sync/pull") return 回(await relay.给拉取(a, u.searchParams.get("teamId")!, Number(u.searchParams.get("after"))));
  if (u.pathname === "/api/sync/push") return 回(await relay.收推送(a, String(b.teamId), String(b.device), String(b.data)));
  if (u.pathname === "/api/sync/leave") return 回(await relay.退队(a, String(b.teamId), typeof b.device === "string" ? b.device : undefined));
  if (u.pathname === "/api/sync/remove") return 回(await relay.移除成员(a, String(b.teamId), String(b.accountId)));
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
  return { 状态: 404, json: { error: `fake: ${路径}` } };
}
const 桌面传: 传输 = (方法, 路径, body) => 调中转(账号[临时.谁], 方法, 路径, body);
const 手机传: 手机.传输 = (方法, 路径, body) => 调中转(账号.li, 方法, 路径, body);

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

let 机: 手机.手机团队;
const 库 = new 手机.内存库();
const 状态 = 手机.新状态();
const 手机轮 = async () => { const r = await 手机.同步一轮(机, 手机传, 库, 状态); 机 = r.c; return r; };
const 手机有 = async (t: string, k: string) => (await 库.取(t, k))?.r;

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
  client = await import("@/lib/sync/client");
  for (const w of ["boss", "li", "zhao"] as const) {
    账号[w] = (await control.account.create({ data: { name: w, email: `${w}@example.invalid`, password: "not-a-login" } })).id;
    fs.writeFileSync(path.join(临时.root, w, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: "dk_test", accountId: 账号[w], name: w, contact: `${w}@example.invalid`, models: [], loggedAt: new Date().toISOString() }));
    await 清空(db(w));
  }
  client.设传输(桌面传);
  当("boss");
  const 码 = await client.建团队("手机QA");
  if (!码.ok) throw Error(码.error);
  await relay.设开通(读配置("boss").teamId, true);
  await db("boss").customer.create({ data: { id: "boss-private", name: "老板私客丙", phone: "13900003331", salesOwnerId: A("boss") } });
  await 都轮("boss");
  for (const w of ["li", "zhao"] as const) { 当(w); expect(await client.加入团队(码.邀请码)).toMatchObject({ ok: true }); }
  await 都轮("li", "zhao", "boss", "li", "zhao");

  // li 的手机：自己生成不可导出的钥匙对，登记成 li 账号的一台设备；团队钥匙照电脑授权时封过去的那份给
  const 钥 = await 密.设备钥匙对();
  const li = 读配置("li");
  expect(await relay.入队(账号.li, li.teamId, li.joinSecret, { device: "m_li_phone", pubKey: 钥.公钥 })).toMatchObject({ ok: true });
  机 = { teamId: li.teamId, device: "m_li_phone", key: li.key, epoch: li.epoch ?? 0, keys: li.keys ?? {}, signPub: li.signPub, userId: A("li"), 私钥: 钥.私钥 };
}, 180_000);
afterAll(async () => {
  client?.设传输(null);
  for (const w of ["boss", "li", "zhao"] as const) await db(w).$disconnect();
  await control?.$disconnect();
  for (const n of ["MULTI_TENANT", "DESKTOP_LOCAL", "SYNC_DIR", "CONTROL_DATABASE_URL", "CRM_DATA_DIR", "CRM_SCOPED_SYNC"]) delete process.env[n];
  fs.rmSync(临时.root, { recursive: true, force: true });
});

describe("手机端同步：和真实桌面端一起", () => {
  it("手机只拿到本人和公海的客户，内容和电脑上一样；老板私客拿不到", async () => {
    const li = db("li");
    await li.customer.create({ data: { id: "c-li", name: "Atlas Home Supplies", phone: "+14155550132", salesOwnerId: A("li") } });
    await li.customerExtra.create({ data: { customerId: "c-li", country: "美国", whatsapp: "+14155550132", email: "maria@atlas.example" } });
    await li.followUp.create({ data: { id: "f-li-1", customerId: "c-li", ownerId: A("li"), type: "SMS", title: "", content: "样品周一到仓" } });
    await li.followPlan.create({ data: { id: "p-li-1", customerId: "c-li", ownerId: A("li"), subject: "确认样品到货", plannedAt: new Date(Date.now() + 3600_000), method: "WhatsApp" } });
    const b = db("boss");
    await b.customer.create({ data: { id: "pool-1", name: "Baltic Furnishings", phone: "+37060000000", salesOwnerId: A("boss") } });
    await b.customerPool.create({ data: { customerId: "pool-1", reason: "手动", userId: A("boss") } });
    await 全轮();

    const r = await 手机轮();
    expect(r.拉).toBeGreaterThan(0);
    expect(状态.skipped).toBe(0);
    expect(await 手机有("Customer", "c-li")).toMatchObject({ name: "Atlas Home Supplies", salesOwnerId: A("li") });
    expect(await 手机有("CustomerExtra", "c-li")).toMatchObject({ country: "美国", whatsapp: "+14155550132" });
    expect(await 手机有("FollowUp", "f-li-1")).toMatchObject({ content: "样品周一到仓", type: "SMS", customerId: "c-li" });
    expect(await 手机有("FollowPlan", "p-li-1")).toMatchObject({ subject: "确认样品到货" });
    expect(await 手机有("Customer", "pool-1")).toMatchObject({ name: "Baltic Furnishings" });
    expect(await 手机有("CustomerPool", "pool-1")).toBeTruthy();
    expect(await 手机有("Customer", "boss-private")).toBeUndefined();
    // 同事账号（显示名字用）也到了；密码、角色这两列本来就不同步
    expect(await 手机有("User", A("li"))).toBeTruthy();
    expect(Object.keys((await 手机有("User", A("li")))!)).not.toContain("password");
  });

  it("手机记一笔（带下次跟进、完成旧计划）：li 的电脑和老板的电脑同步后都看得到，时间、类型都对", async () => {
    const 记的时候 = Date.now();
    const { id } = await 手机.记跟进(机, 库, 状态, { customerId: "c-li", type: "PHONE", content: "Maria 确认样品到了，试单 1 个 40HQ", 下次: { 时间: 记的时候 + 3 * 86400_000, 主题: "接着跟进：试单数量", 方式: "WhatsApp" }, 完成计划: "p-li-1" });
    expect(await 手机有("FollowUp", id)).toMatchObject({ content: "Maria 确认样品到了，试单 1 个 40HQ" });
    expect(状态.待推.length).toBeGreaterThan(0);
    const r = await 手机轮();
    expect(r.推).toBeGreaterThan(0);
    expect(状态.待推).toEqual([]);
    expect(状态.被拒).toEqual([]);
    await 全轮();
    for (const w of ["li", "boss"] as const) {
      const f = await db(w).followUp.findUnique({ where: { id } });
      expect(f).toMatchObject({ type: "PHONE", status: "已完成", content: "Maria 确认样品到了，试单 1 个 40HQ", ownerId: A("li"), customerId: "c-li" });
      expect(Math.abs(f!.occurredAt.getTime() - 记的时候)).toBeLessThan(1000);
      expect(await db(w).followPlan.findUnique({ where: { id: "p-li-1" } })).toMatchObject({ done: true });
      const 新计划 = await db(w).followPlan.findFirst({ where: { customerId: "c-li", done: false } });
      expect(新计划).toMatchObject({ subject: "接着跟进：试单数量", method: "WhatsApp" });
      expect(新计划!.plannedAt.getTime()).toBe(记的时候 + 3 * 86400_000);
      expect(await db(w).auditLog.count({ where: { entityId: id } })).toBe(1);
    }
    // zhao 是别人的业务员：看不到 li 的客户和这条跟进
    expect(await db("zhao").followUp.findUnique({ where: { id } })).toBeNull();
  });

  it("电脑上新记、改的，手机同步后看得到", async () => {
    当("li");
    await db("li").followUp.create({ data: { id: "f-li-2", customerId: "c-li", ownerId: A("li"), type: "EMAIL", title: "", content: "发了修改后的报价单" } });
    await db("li").customer.update({ where: { id: "c-li" }, data: { name: "Atlas Home Supplies Inc." } });
    await 都轮("li");
    await 手机轮();
    expect(await 手机有("FollowUp", "f-li-2")).toMatchObject({ content: "发了修改后的报价单", type: "EMAIL" });
    expect(await 手机有("Customer", "c-li")).toMatchObject({ name: "Atlas Home Supplies Inc." });
  });

  it("断网时记的、推之前客户被老板转走：推上去被拒，进「被拒」，不悄悄丢；客户从手机上消失", async () => {
    await db("li").customer.create({ data: { id: "c-li-2", name: "Nordlicht GmbH", phone: "+493055501188", salesOwnerId: A("li") } });
    await 全轮();
    await 手机轮();
    expect(await 手机有("Customer", "c-li-2")).toBeTruthy();
    // 手机「断网」记了一条（只进待推）
    await 手机.记跟进(机, 库, 状态, { customerId: "c-li-2", type: "SMS", content: "Jonas 要 CE 证书" });
    // 这期间老板把客户转给 zhao
    await db("boss").customer.update({ where: { id: "c-li-2" }, data: { salesOwnerId: A("zhao") } });
    await 全轮();
    await 手机轮();
    expect(状态.被拒.map((x) => x.改动.t)).toContain("FollowUp");
    expect(状态.被拒.find((x) => x.改动.t === "FollowUp")!.改动.r).toMatchObject({ content: "Jonas 要 CE 证书" });
    expect(状态.待推).toEqual([]);
    expect(await 手机有("Customer", "c-li-2")).toBeUndefined();
    // 被拒的那条没进任何人的电脑
    for (const w of ["li", "boss", "zhao"] as const) expect(await db(w).followUp.count({ where: { content: "Jonas 要 CE 证书" } })).toBe(0);
  });

  it("老板移除 zhao、换了钥匙：手机拿到封给自己的新钥匙，照样能收能推", async () => {
    const 旧编号 = 机.epoch;
    当("boss");
    expect(await client.移除成员(账号.zhao)).toMatchObject({ ok: true });
    expect(读配置("boss").epoch).toBeGreaterThan(旧编号);
    await 都轮("boss", "li");
    await db("li").followUp.create({ data: { id: "f-li-3", customerId: "c-li", ownerId: A("li"), type: "VISIT", title: "", content: "换钥匙之后记的" } });
    await 都轮("li");
    await 手机轮();
    expect(机.epoch).toBeGreaterThan(旧编号);
    expect(await 手机有("FollowUp", "f-li-3")).toMatchObject({ content: "换钥匙之后记的" });
    const { id } = await 手机.记跟进(机, 库, 状态, { customerId: "c-li", type: "OTHER", content: "手机用新钥匙推的" });
    await 手机轮();
    await 都轮("li", "boss");
    expect(await db("boss").followUp.findUnique({ where: { id } })).toMatchObject({ content: "手机用新钥匙推的" });
    expect(状态.skipped).toBe(0);
  });
});
