/**
 * 范围同步：本机表结构变了（升级多了列 / 表）就各范围从头重拉（2026-10-22，交接风险 #3，附件同步的前置）。
 * 旧协议早就这么做（client.ts 本机结构签名 → c.结构）；范围同步原来没有：老版本收到一包带新列的，新列丢掉、游标照样往前，
 * 升级以后那些值再也拉不回来。附件表进同步表以后，老版本那几包整包跳过，升级后同样补不回来。
 * 台子同 sync-scoped-join-order：两台都走真实 lib/sync/client.ts，云端是真实的 sync-relay + sync-scoped（临时控制库）。
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

type 谁 = "boss" | "li";
const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-scoped-repull-"));
  for (const who of ["boss", "li"]) {
    fs.mkdirSync(path.join(root, who), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(root, who, "crm.db"));
    if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(root, who, "crm.db-wal"));
  }
  return { root, 谁: "boss" as "boss" | "li" };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  const mk = (w: string) => new PrismaClient({ datasourceUrl: `file:${path.join(临时.root, w, "crm.db")}?connection_limit=1` });
  const dbs = { boss: mk("boss"), li: mk("li") };
  (globalThis as { __dbs?: typeof dbs }).__dbs = dbs;
  const prisma = new Proxy({}, { get: (_t, p) => { const db = dbs[临时.谁] as unknown as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(db) : v; } });
  return { prisma };
});

import type { PrismaClient } from "@/generated/prisma";
import type { 传输 } from "@/lib/sync/client";
import { 装触发器, 卸触发器, 本机结构签名 } from "@/lib/sync/local";

let client: typeof import("@/lib/sync/client");
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
let control: typeof import("@/lib/tenant/control").control;
const 账号: Record<谁, string> = { boss: "", li: "" };
const db = (w: 谁) => (globalThis as unknown as { __dbs: Record<string, PrismaClient> }).__dbs[w];
function 当(w: 谁) { 临时.谁 = w; process.env.CRM_DATA_DIR = path.join(临时.root, w); }
const A = (w: 谁) => `acct_${账号[w]}`;

/** 和云端说话：桌面端按「当前是谁」 */
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
      else if (act === "pull-many") r = await scoped.给多个范围拉取(a, t, b.scopes);
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

async function 清空(d: PrismaClient) {
  for (const t of ["AiMessage", "AiConversation", "AiProject", "Setting", "AuditLog", "ImportRow", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerClaim", "CustomerPool"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.user.create({ data: { id: "cmusc55660000dulko96ek8kr", email: "admin", name: "管理员", role: "ADMIN", password: "x", title: "管理员", createdAt: new Date("2026-10-01T00:00:00Z") } });
}
const 轮 = async (w: 谁) => { 当(w); return client.同步一轮(); };
const 都轮 = async (...ws: 谁[]) => { for (const w of ws) expect(await 轮(w)).toMatchObject({ ok: true }); };
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
  client = await import("@/lib/sync/client");
  for (const w of ["boss", "li"] as const) {
    账号[w] = (await control.account.create({ data: { name: w, email: `${w}@example.invalid`, password: "not-a-login" } })).id;
    fs.writeFileSync(path.join(临时.root, w, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: "dk_test", accountId: 账号[w], name: w, contact: `${w}@example.invalid`, models: [], loggedAt: new Date().toISOString() }));
    await 清空(db(w));
  }
  client.设传输(桌面传);
  当("boss");
  const 码 = await client.建团队("重拉QA");
  if (!码.ok) throw Error(码.error);
  await relay.设开通(读配置("boss").teamId, true);
  await 都轮("boss");
  当("li");
  expect(await client.加入团队(码.邀请码)).toMatchObject({ ok: true });
  await db("li").customer.create({ data: { id: "c-li", name: "业务员的客户", phone: "13900003333", salesOwnerId: A("li") } });
  await db("li").customerExtra.create({ data: { customerId: "c-li", country: "美国" } });
  await 都轮("li", "boss", "li");
}, 180_000);
afterAll(async () => {
  client?.设传输(null);
  for (const w of ["boss", "li"] as const) await db(w).$disconnect();
  await control?.$disconnect();
  for (const n of ["MULTI_TENANT", "DESKTOP_LOCAL", "SYNC_DIR", "CONTROL_DATABASE_URL", "CRM_DATA_DIR", "CRM_SCOPED_SYNC"]) delete process.env[n];
  fs.rmSync(临时.root, { recursive: true, force: true });
});

/** 业务员那台的外贸档案（直接读 SQLite：降级期间 Prisma 模型带 alibabaId 列，查不了） */
const 档案 = async () => (await db("li").$queryRawUnsafe<Record<string, unknown>[]>('SELECT * FROM "CustomerExtra" WHERE "customerId" = ?', "c-li"))[0];
/** 改业务员本机表结构：先卸触发器（触发器里点了列名），改完再装回去（同一进程里客户端只对一次触发器） */
async function 改表(sql: string) {
  const d = db("li");
  await 卸触发器(d);
  await d.$executeRawUnsafe(sql);
  await 装触发器(d);
}

describe("范围同步：本机表结构变了就从头重拉", () => {
  it("首轮记下本机表结构签名", async () => {
    当("li");
    expect(读配置("li").scoped?.结构).toBe(await 本机结构签名(db("li")));
  });

  it("老版本收不下的新列：升级以后从头重拉补齐，后面的照常收", async () => {
    // 业务员这台是老版本：外贸档案没有阿里 ID 那一列（也没有引用它的查重索引 048，先拆索引才删得了列）
    await 改表('DROP INDEX IF EXISTS "CustomerExtra_alibabaIdKey_idx"');
    await 改表('ALTER TABLE "CustomerExtra" DROP COLUMN "alibabaId"');
    await 都轮("li");
    const 老签名 = await 本机结构签名(db("li"));
    // 老板给业务员的客户填阿里 ID；业务员老版本收到这一包，新列丢掉、游标往前
    await db("boss").customerExtra.update({ where: { customerId: "c-li" }, data: { alibabaId: "us-ali-001" } });
    await 都轮("boss", "li");
    expect(await 档案()).toMatchObject({ country: "美国" });
    expect(await 档案()).not.toHaveProperty("alibabaId");
    // 升级：补上这一列，表结构签名变了
    await 改表('ALTER TABLE "CustomerExtra" ADD COLUMN "alibabaId" TEXT');
    expect(await 本机结构签名(db("li"))).not.toBe(老签名);
    await 都轮("li");
    expect(await 档案()).toMatchObject({ country: "美国", alibabaId: "us-ali-001" });
    expect(读配置("li").scoped?.结构).toBe(await 本机结构签名(db("li")));
    // 重拉过一遍之后照常增量：老板再改，业务员一轮就到
    await db("boss").customerExtra.update({ where: { customerId: "c-li" }, data: { alibabaId: "us-ali-002" } });
    await 都轮("boss", "li");
    expect(await 档案()).toMatchObject({ alibabaId: "us-ali-002" });
  });

  it("表结构没变：游标不归零，不重拉", async () => {
    const 前 = 读配置("li").scoped!.cursors;
    expect(Object.keys(前).length).toBeGreaterThan(0);
    await 都轮("li");
    expect(读配置("li").scoped!.cursors).toEqual(前);
  });
});

describe("范围同步：本机缺了记录、游标却说已拉齐，就从头补拉（2026-10-29）", () => {
  /** 模拟本机库被换过 / 删过一批：不经触发器删掉这一行和它的同步痕迹，不会推出删除 */
  async function 本机丢了(id: string) {
    const d = db("li");
    await 卸触发器(d);
    await d.$executeRawUnsafe('DELETE FROM "CustomerExtra" WHERE "customerId" = ?', id);
    await d.$executeRawUnsafe('DELETE FROM "Customer" WHERE "id" = ?', id);
    for (const aux of ["_sync_log", "_sync_field", "_sync_tomb", "_sync_skip"]) await d.$executeRawUnsafe(`DELETE FROM ${aux} WHERE pk = ?`, id);
    await 装触发器(d);
  }

  it("本机丢了的客户下一轮补回来，云端那份不受影响", async () => {
    await 都轮("li");
    await 本机丢了("c-li");
    expect(await db("li").customer.count({ where: { id: "c-li" } })).toBe(0);
    await 都轮("li");
    expect(await db("li").customer.findUnique({ where: { id: "c-li" } })).toMatchObject({ name: "业务员的客户", salesOwnerId: A("li") });
    expect(await 档案()).toMatchObject({ country: "美国" });
    // 老板那边照旧在
    await 都轮("boss");
    expect(await db("boss").customer.count({ where: { id: "c-li" } })).toBe(1);
  });

  it("补齐以后不再每轮从头拉：游标不变", async () => {
    await 都轮("li");
    const 前 = 读配置("li").scoped!.cursors;
    await 都轮("li");
    expect(读配置("li").scoped!.cursors).toEqual(前);
  });

  it("同一个 head 补过一次还缺的，不再每轮重拉；head 变了再补", async () => {
    await 都轮("li");
    const 范围 = Object.keys(读配置("li").scoped!.补过 ?? {});
    expect(范围.length).toBeGreaterThan(0);
    // 假装上一轮已经在当前 head 补过：本机再丢，这一轮不补
    const c = 读配置("li");
    const 头 = Object.fromEntries(Object.entries(c.scoped!.cursors).map(([k, v]) => [k, v.after]));
    client.写团队({ ...c, scoped: { ...c.scoped!, 补过: 头 } });
    await 本机丢了("c-li");
    await 都轮("li");
    expect(await db("li").customer.count({ where: { id: "c-li" } })).toBe(0);
    // 老板一改，head 变了，这一轮补回来
    await db("boss").customer.update({ where: { id: "c-li" }, data: { name: "业务员的客户（改）" } });
    await 都轮("boss", "li");
    expect(await db("li").customer.findUnique({ where: { id: "c-li" } })).toMatchObject({ name: "业务员的客户（改）" });
  });
});
