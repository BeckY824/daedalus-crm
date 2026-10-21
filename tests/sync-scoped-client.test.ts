/**
 * v4 范围同步端到端（2026-10-13，Sam F2：业务员 SQLite 里有老板私客）。
 * 两台桌面端都走真实 lib/sync/client.ts；云端是真实的 lib/tenant/sync-relay.ts + sync-scoped.ts（临时控制库）。
 * 流程：旧协议全队复制（复现 F2）→ 开灰度 → 老板先迁移 → 业务员升级后清理 → F1–F7 回归。
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-scoped-client-"));
  for (const who of ["boss", "member"]) {
    fs.mkdirSync(path.join(root, who), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(root, who, "crm.db"));
    if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(root, who, "crm.db-wal"));
  }
  return { root, 谁: "boss" as "boss" | "member" };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  const dbs = { boss: new PrismaClient({ datasourceUrl: `file:${path.join(临时.root, "boss", "crm.db")}` }), member: new PrismaClient({ datasourceUrl: `file:${path.join(临时.root, "member", "crm.db")}` }) };
  (globalThis as { __dbs?: typeof dbs }).__dbs = dbs;
  const prisma = new Proxy({}, { get: (_t, p) => { const db = dbs[临时.谁] as unknown as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(db) : v; } });
  return { prisma };
});

import type { PrismaClient } from "@/generated/prisma";
import { 设备钥匙对, 拆范围 } from "@/lib/sync/crypto";
import type { 传输 } from "@/lib/sync/client";

let client: typeof import("@/lib/sync/client");
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
let control: typeof import("@/lib/tenant/control").control;
const 账号 = { boss: "", member: "" };
const db = (w: "boss" | "member") => (globalThis as unknown as { __dbs: Record<string, PrismaClient> }).__dbs[w];
function 当(w: "boss" | "member") {
  临时.谁 = w;
  process.env.CRM_DATA_DIR = path.join(临时.root, w);
}
const 作为 = async <T>(w: "boss" | "member", fn: () => Promise<T>) => { 当(w); return fn(); };
void 设备钥匙对;

/** 注入一次故障：模拟迁移中途断网（返回 0 = 连不上） */
let 断一次: ((action: string) => boolean) | null = null;
const 传: 传输 = async (方法, 路径, body) => {
  const a = 账号[临时.谁];
  if (断一次 && 路径 === "/api/sync/scoped" && 断一次(String((body as { action?: string })?.action))) { 断一次 = null; return { 状态: 0, json: { error: "连不上云端" } }; }
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
  if (u.pathname === "/api/sync/scoped") {
    const { POST } = await import("@/app/api/sync/scoped/route");
    void POST;
    const t = String(b.teamId), act = String(b.action);
    try {
      if (act !== "state" && !(await scoped.范围开放(t))) return { 状态: 404, json: { error: "范围同步尚未开放" } };
      const r = act === "state" ? await scoped.范围状态(a, t) : act === "directory" ? await scoped.范围目录(a, t) : act === "begin" ? await scoped.开始范围迁移(a, t, String(b.device)) : act === "commit" ? await scoped.完成范围迁移(a, t, String(b.device), Number(b.count)) : act === "push" ? await scoped.收范围推送(a, t, String(b.device), b.packets as never) : await scoped.给范围拉取(a, t, String(b.scopeId), Number(b.after));
      return { 状态: 200, json: r as unknown as Record<string, unknown> };
    } catch (e) {
      if (e instanceof scoped.范围错误) return { 状态: e.状态, json: { error: e.message } };
      throw e;
    }
  }
  return { 状态: 404, json: { error: `fake: ${路径}` } };
};

const 模板 = [{ id: "cmusc55660000dulko96ek8kr", email: "admin", name: "管理员", role: "ADMIN" }];
async function 清空(d: PrismaClient) {
  for (const t of ["AiMessage", "AiConversation", "AiProject", "Setting", "AuditLog", "ImportRow", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerPool"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  for (const u of 模板) await d.user.create({ data: { ...u, password: "x", title: "管理员", createdAt: new Date("2026-10-01T00:00:00Z") } });
}
/** 直接读整个 SQLite 文件（含同步日志、导入撤销快照）找敏感串：等同 Sam 用只读工具打开 crm.db */
async function 库里有(d: PrismaClient, 串: string) {
  const tables = await d.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  const 命中: string[] = [];
  for (const { name } of tables) {
    const cols = await d.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info("${name}")`);
    if (!cols.length) continue;
    const rows = await d.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM "${name}" WHERE ${cols.map((c) => `CAST("${c.name}" AS TEXT) LIKE ?`).join(" OR ")}`, ...cols.map(() => `%${串}%`));
    if (Number(rows[0].n)) 命中.push(name);
  }
  return 命中;
}
const 轮 = async (w: "boss" | "member") => { 当(w); const r = await client.同步一轮(); return r; };
const 读配置 = (w: "boss" | "member") => { 当(w); return client.读团队()!; };

beforeAll(async () => {
  process.env.MULTI_TENANT = "1";
  process.env.DESKTOP_LOCAL = "1";
  process.env.SYNC_DIR = path.join(临时.root, "sync");
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时.root, "control.db")}`;
  const sql = execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(临时.root, "schema.sql"), sql);
  execFileSync(process.execPath, ["--experimental-sqlite", "-e", "const fs=require('node:fs');const d=new(require('node:sqlite').DatabaseSync)(process.argv[1]);d.exec(fs.readFileSync(process.argv[2],'utf8'));d.close()", path.join(临时.root, "control.db"), path.join(临时.root, "schema.sql")], { stdio: "pipe" });
  ({ control } = await import("@/lib/tenant/control"));
  relay = await import("@/lib/tenant/sync-relay");
  scoped = await import("@/lib/tenant/sync-scoped");
  client = await import("@/lib/sync/client");
  for (const w of ["boss", "member"] as const) {
    const a = await control.account.create({ data: { name: w, email: `${w}@example.invalid`, password: "not-a-login" } });
    账号[w] = a.id;
    fs.writeFileSync(path.join(临时.root, w, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: "dk_test", accountId: a.id, name: w, contact: `${w}@example.invalid`, models: [], loggedAt: new Date().toISOString() }));
    await 清空(db(w));
  }
  client.设传输(传);
}, 120_000);
afterAll(async () => {
  client?.设传输(null);
  for (const w of ["boss", "member"] as const) await db(w).$disconnect();
  await control?.$disconnect();
  for (const n of ["MULTI_TENANT", "DESKTOP_LOCAL", "SYNC_DIR", "CONTROL_DATABASE_URL", "CRM_DATA_DIR", "CRM_SCOPED_SYNC"]) delete process.env[n];
  fs.rmSync(临时.root, { recursive: true, force: true });
});

const B = () => `acct_${账号.boss}`, M = () => `acct_${账号.member}`;
const 老板私客 = "QA老板私客甲";
const 老板电话 = "13900001611";

describe("v4 范围同步：业务员只同步本人 + 公海，老板全队", () => {
  it("旧协议：业务员本机 SQLite 收到老板私客（复现 Sam F2 证据）", async () => {
    const 码 = await 作为("boss", () => client.建团队("范围QA"));
    if (!码.ok) throw Error(码.error);
    await relay.设开通(读配置("boss").teamId, true);
    const b = db("boss");
    await b.customer.create({ data: { id: "boss-private", name: 老板私客, phone: 老板电话, salesOwnerId: B() } });
    await b.contact.create({ data: { id: "boss-contact", name: "QA老板联系人", customerId: "boss-private" } });
    await b.followUp.create({ data: { id: "boss-follow", customerId: "boss-private", ownerId: B(), type: "PHONE", title: "电话", content: "QA老板私密跟进" } });
    await b.customer.create({ data: { id: "pool-1", name: "QA公海客户", phone: "13900002222", salesOwnerId: B() } });
    await b.customerPool.create({ data: { customerId: "pool-1", reason: "手动" } });
    expect(await 轮("boss")).toMatchObject({ ok: true });
    const j = await 作为("member", () => client.加入团队(码.邀请码));
    expect(j).toMatchObject({ ok: true });
    await db("member").customer.create({ data: { id: "member-own", name: "QA业务员自有", phone: "13900008882", salesOwnerId: M() } });
    expect(await 轮("member")).toMatchObject({ ok: true });
    expect(await 轮("boss")).toMatchObject({ ok: true });
    expect(await 轮("member")).toMatchObject({ ok: true });
    expect(await db("member").customer.findUnique({ where: { id: "boss-private" } })).not.toBeNull();
    expect(await db("boss").customer.findUnique({ where: { id: "member-own" } })).not.toBeNull();
  });

  it("开灰度后旧协议的业务员被拒（不能绕过），本机离线改动留着", async () => {
    process.env.CRM_SCOPED_SYNC = "1";
    await db("member").customer.update({ where: { id: "member-own" }, data: { remark: "离线改了自己的" } });
    await db("member").customer.update({ where: { id: "boss-private" }, data: { remark: "业务员偷改老板私客" } });
    await db("member").importBatch.create({ data: { id: "imp-1", userId: M(), userName: "member", fileName: "a.xlsx", rows: { create: [{ customerId: "boss-private", kind: "update", before: JSON.stringify({ remark: `${老板私客}原备注` }) }, { customerId: "member-own", kind: "update", before: "{}" }] } } });
    const r = await 轮("member");
    expect(r.ok).toBe(false);
  });

  it("老板先迁移：备份、冻结、起点、开放；迁移后旧接口全部拒绝", async () => {
    // 第一次在 commit 前断网：起点已推完、留在本机文件；下一轮从断点续做，服务端批次不重复
    断一次 = (action) => action === "commit";
    expect((await 轮("boss")).ok).toBe(false);
    expect(fs.existsSync(path.join(临时.root, "boss", "scoped-sync-migration-baseline.json"))).toBe(true);
    const 中途 = await control.syncScopedBatch.count();
    expect(中途).toBeGreaterThan(0);
    // 冻结期间业务员仍不能用旧接口
    expect((await 轮("member")).ok).toBe(false);
    const r = await 轮("boss");
    expect(r).toMatchObject({ ok: true });
    expect(await control.syncScopedBatch.count()).toBe(中途);
    当("boss");
    expect(fs.existsSync(client.迁移备份文件())).toBe(true);
    expect(fs.existsSync(path.join(临时.root, "boss", "scoped-sync-migration-baseline.json"))).toBe(false);
    expect(读配置("boss").scoped?.stage).toBe("ready");
    const teamId = 读配置("boss").teamId;
    expect(await relay.给拉取(账号.boss, teamId, 0)).toMatchObject({ ok: false, 状态: 409 });
    expect(await relay.给拉取(账号.member, teamId, 0)).toMatchObject({ ok: false, 状态: 409 });
    // 控制库与密文落盘都不含明文
    const raw = JSON.stringify(await control.syncScopedRecord.findMany()) + JSON.stringify(await control.syncScopedBatch.findMany());
    expect(raw).not.toContain(老板私客);
    expect(raw).not.toContain(老板电话);
  });

  it("业务员升级：老板私客及跟进/联系人/同步日志/导入撤销副本全部清掉；自有数据和离线改动保留；失权改动成为显式冲突", async () => {
    const r = await 轮("member");
    expect(r).toMatchObject({ ok: true });
    const m = db("member");
    expect(await 库里有(m, 老板私客)).toEqual([]);
    expect(await 库里有(m, 老板电话)).toEqual([]);
    expect(await 库里有(m, "QA老板私密跟进")).toEqual([]);
    expect(await m.customer.findUnique({ where: { id: "boss-private" } })).toBeNull();
    expect(await m.contact.findUnique({ where: { id: "boss-contact" } })).toBeNull();
    expect(await m.importRow.count({ where: { customerId: "boss-private" } })).toBe(0);
    expect(await m.importRow.count({ where: { customerId: "member-own" } })).toBe(1);
    expect((await m.customer.findUnique({ where: { id: "member-own" } }))?.remark).toBe("离线改了自己的");
    expect(await m.customer.findUnique({ where: { id: "pool-1" } })).not.toBeNull();
    当("member");
    const 概况 = await client.范围同步概况();
    expect(概况.冲突).toBe(1);
    const c = await m.$queryRawUnsafe<{ tbl: string; pk: string; row: string }[]>("SELECT tbl, pk, row FROM _sync_scope_conflict");
    expect(c[0]).toMatchObject({ tbl: "Customer", pk: "boss-private" });
    expect(c[0].row).toContain("业务员偷改老板私客");
    // 老板没收到偷改，收到了业务员自己的离线改动
    expect(await 轮("boss")).toMatchObject({ ok: true });
    expect((await db("boss").customer.findUnique({ where: { id: "boss-private" } }))?.remark ?? null).not.toBe("业务员偷改老板私客");
    expect((await db("boss").customer.findUnique({ where: { id: "member-own" } }))?.remark).toBe("离线改了自己的");
  });

  it("F1 双向业务：老板改公海客户、业务员改自有并加跟进，两边都到", async () => {
    await db("boss").customer.update({ where: { id: "pool-1" }, data: { remark: "老板改公海" } });
    await db("member").followUp.create({ data: { id: "member-follow", customerId: "member-own", ownerId: M(), type: "PHONE", title: "电话", content: "业务员跟进" } });
    expect(await 轮("boss")).toMatchObject({ ok: true });
    expect(await 轮("member")).toMatchObject({ ok: true });
    expect(await 轮("boss")).toMatchObject({ ok: true });
    expect((await db("member").customer.findUnique({ where: { id: "pool-1" } }))?.remark).toBe("老板改公海");
    expect(await db("boss").followUp.findUnique({ where: { id: "member-follow" } })).not.toBeNull();
  });

  it("人多放慢（2026-10-21）：团队到 10 人，目录里的 pace 记进本机团队配置、壳的定时戳没到 20 秒就跳过；人少了回到不放慢", async () => {
    const teamId = 读配置("boss").teamId;
    const 加的: string[] = [];
    for (let i = 0; i < 8; i++) {
      const a = await control.account.create({ data: { name: `pace${i}`, email: `pace${i}@example.invalid`, password: "not-a-login" } });
      await control.syncMember.create({ data: { teamId, accountId: a.id } });
      加的.push(a.id);
    }
    expect(await 轮("boss")).toMatchObject({ ok: true });
    expect(读配置("boss").pace).toBe(20);
    expect(client.该放慢(读配置("boss"))).toBe(true);
    await control.syncMember.deleteMany({ where: { teamId, accountId: { in: 加的 } } });
    expect(await 轮("boss")).toMatchObject({ ok: true });
    expect(读配置("boss").pace).toBe(0);
    expect(client.该放慢(读配置("boss"))).toBe(false);
  });

  it("F2 领取公海 / 转交：领取后归业务员；老板转走后业务员本机删掉、离线改动成冲突", async () => {
    const m = db("member");
    await m.customer.update({ where: { id: "pool-1" }, data: { salesOwnerId: M() } });
    await m.customerPool.delete({ where: { customerId: "pool-1" } });
    expect(await 轮("member")).toMatchObject({ ok: true });
    expect(await 轮("boss")).toMatchObject({ ok: true });
    expect((await db("boss").customer.findUnique({ where: { id: "pool-1" } }))?.salesOwnerId).toBe(M());
    expect(await db("boss").customerPool.findUnique({ where: { customerId: "pool-1" } })).toBeNull();
    // 老板把业务员自有客户转给自己；业务员同时离线改了它
    await db("boss").customer.update({ where: { id: "member-own" }, data: { salesOwnerId: B() } });
    expect(await 轮("boss")).toMatchObject({ ok: true });
    await m.customer.update({ where: { id: "member-own" }, data: { remark: "转走前的离线改动" } });
    expect(await 轮("member")).toMatchObject({ ok: true });
    expect(await m.customer.findUnique({ where: { id: "member-own" } })).toBeNull();
    expect(await m.followUp.findUnique({ where: { id: "member-follow" } })).toBeNull();
    const rows = await m.$queryRawUnsafe<{ row: string }[]>("SELECT row FROM _sync_scope_conflict WHERE pk = 'member-own'");
    expect(rows.some((r) => r.row.includes("转走前的离线改动"))).toBe(true);
    // 冲突只留本人改的列，失权客户的电话不随冲突留在本机
    expect(await 库里有(m, "13900008882")).toEqual([]);
  });

  it("F3 联系人改归属：老板把联系人挂到业务员客户下，业务员收到；不能借外键收到隐藏客户", async () => {
    // 老板时期的改动（挂在老板私客下时）先同步上云
    await db("boss").contact.update({ where: { id: "boss-contact" }, data: { name: "QA联系人现名" } });
    expect(await 轮("boss")).toMatchObject({ ok: true });
    await db("boss").contact.update({ where: { id: "boss-contact" }, data: { customerId: "pool-1" } });
    expect(await 轮("boss")).toMatchObject({ ok: true });
    expect(await 轮("member")).toMatchObject({ ok: true });
    const c = await db("member").contact.findUnique({ where: { id: "boss-contact" } });
    expect(c).toMatchObject({ customerId: "pool-1", name: "QA联系人现名" });
    // 业务员能拉到的密文里只有改归属之后的起点：没有老板时期的旧名和挂在老板私客下的历史
    const cfg = 读配置("member");
    const got = await scoped.给范围拉取(账号.member, cfg.teamId, "Customer:pool-1", 0);
    const plain = got.batches.map((b) => JSON.stringify(拆范围(b.data, { ...(cfg.keys ?? {}), [String(cfg.epoch ?? 0)]: cfg.key }, { teamId: cfg.teamId, device: b.device, eventId: b.eventId, meta: b.meta }))).join("\n");
    expect(plain).toContain("QA联系人现名");
    expect(plain).not.toContain("QA老板联系人");
    expect(plain).not.toContain("boss-private");
    expect(await db("member").customer.findUnique({ where: { id: "boss-private" } })).toBeNull();
  });

  it("F4 离线不同字段合并：两边各改 pool-1 的不同字段", async () => {
    await db("boss").customer.update({ where: { id: "pool-1" }, data: { remark: "老板备注" } });
    await db("member").customer.update({ where: { id: "pool-1" }, data: { name: "QA公海客户（业务员改名）" } });
    expect(await 轮("member")).toMatchObject({ ok: true });
    expect(await 轮("boss")).toMatchObject({ ok: true });
    expect(await 轮("member")).toMatchObject({ ok: true });
    for (const w of ["boss", "member"] as const) expect(await db(w).customer.findUnique({ where: { id: "pool-1" } })).toMatchObject({ remark: "老板备注", name: "QA公海客户（业务员改名）" });
  });

  it("F5 恢复旧备份：业务员库里重新出现老板私客，下一轮清掉且不推给云端", async () => {
    const m = db("member");
    await m.$executeRawUnsafe("UPDATE _sync_state SET applying = 1 WHERE id = 1");
    await m.$executeRawUnsafe(`INSERT INTO "Customer" (id, name, phone, salesOwnerId, createdAt, updatedAt) VALUES ('boss-private', ?, ?, ?, 0, 0)`, 老板私客, 老板电话, B());
    await m.$executeRawUnsafe("UPDATE _sync_state SET applying = 0 WHERE id = 1");
    const before = await control.syncScopedBatch.count();
    expect(await 轮("member")).toMatchObject({ ok: true });
    expect(await m.customer.findUnique({ where: { id: "boss-private" } })).toBeNull();
    expect(await control.syncScopedBatch.count()).toBe(before);
    expect((await db("boss").customer.findUnique({ where: { id: "boss-private" } }))?.name).toBe(老板私客);
  });

  it("F6/F7 退出团队：业务员只留自己的，冲突记录不删；老板库完整", async () => {
    当("member");
    expect(await client.退出团队()).toMatchObject({ ok: true });
    const m = db("member");
    expect(await m.customer.findUnique({ where: { id: "pool-1" } })).not.toBeNull(); // 领取后归自己
    expect(Number((await m.$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM _sync_scope_conflict"))[0].n)).toBeGreaterThan(0);
    expect(await db("boss").customer.count()).toBeGreaterThanOrEqual(3);
  });
});
