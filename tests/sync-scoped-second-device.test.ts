/**
 * 范围同步：同一账号的第二台电脑（2026-10-14 候选 6 实机：li 在 Windows 上领取，Mac 上公海那一行一直不走）。
 * 四台真实客户端：老板、li（第一台）、li2（li 账号的第二台）、zhao；云端真实 sync-relay + sync-scoped。
 * 领取 / 撤销领取 / 第二台领取 / 交接出去 / 交给 li / 老板批量改负责人 / 放公海 / 删除，每一步两台 li 都要一致；
 * 以及「已经卡住」的设备（游标早过了删除包）照目录补删除。
 * 原文件头：范围同步：领取与交接（2026-10-14 修复，docs/范围同步-领取与交接修复-2026-10-14.md）。
 * 三台桌面端（老板、li、zhao）都走真实 lib/sync/client.ts；云端是真实的 sync-relay + sync-scoped（临时控制库）。
 *  - Bug 1：业务员按旧顺序（先删公海、再改负责人）领取 → 原来服务端逐包核、删公海那一包 403、各台负责人对不上
 *  - Bug 2：业务员把客户交给同事 → 原来交出去的人补不了起点、接手的人永远拉不到；转交后改的计划 / 操作日志被拒成冲突
 *  - 加固：清理失权副本之后库文件（crm.db + WAL）原始字节里搜不到删掉的客户
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

type 谁 = "boss" | "li" | "li2" | "zhao";
const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-scoped-second-"));
  for (const who of ["boss", "li", "li2", "zhao"]) {
    fs.mkdirSync(path.join(root, who), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(root, who, "crm.db"));
    if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(root, who, "crm.db-wal"));
  }
  return { root, 谁: "boss" as "boss" | "li" | "li2" | "zhao" };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  // 和桌面端一样只开一个连接（lib/sqlite-url 单连接）：secure_delete、VACUUM 都落在同一个连接上
  const mk = (w: string) => new PrismaClient({ datasourceUrl: `file:${path.join(临时.root, w, "crm.db")}?connection_limit=1` });
  const dbs = { boss: mk("boss"), li: mk("li"), li2: mk("li2"), zhao: mk("zhao") };
  (globalThis as { __dbs?: typeof dbs }).__dbs = dbs;
  const prisma = new Proxy({}, { get: (_t, p) => { const db = dbs[临时.谁] as unknown as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(db) : v; } });
  return { prisma };
});

import type { PrismaClient } from "@/generated/prisma";
import type { 传输 } from "@/lib/sync/client";

let client: typeof import("@/lib/sync/client");
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
let control: typeof import("@/lib/tenant/control").control;
const 账号: Record<谁, string> = { boss: "", li: "", li2: "", zhao: "" };
const db = (w: 谁) => (globalThis as unknown as { __dbs: Record<string, PrismaClient> }).__dbs[w];
function 当(w: 谁) { 临时.谁 = w; process.env.CRM_DATA_DIR = path.join(临时.root, w); }
/** 传输层和 sync-scoped-handover 同一份；这份不模拟旧服务端 */
const 旧服务端 = false as boolean;
const 推送记录: { 谁: 谁; 包: number; 状态: number }[] = [];

const 传: 传输 = async (方法, 路径, body) => {
  const a = 账号[临时.谁];
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
    const t = String(b.teamId), act = String(b.action);
    try {
      if (act !== "state" && !(await scoped.范围开放(t))) return { 状态: 404, json: { error: "范围同步尚未开放" } };
      let r: unknown;
      if (act === "state") { const s = await scoped.范围状态(a, t); r = 旧服务端 ? { ...s, pushRule: undefined, maxPackets: undefined } : s; }
      else if (act === "directory") r = await scoped.范围目录(a, t);
      else if (act === "begin") r = await scoped.开始范围迁移(a, t, String(b.device));
      else if (act === "commit") r = await scoped.完成范围迁移(a, t, String(b.device), Number(b.count));
      else if (act === "push") {
        const packets = b.packets as never[];
        if (旧服务端 && packets.length > 100) return { 状态: 413, json: { error: "请分批推送范围改动" } };
        r = await scoped.收范围推送(a, t, String(b.device), packets);
        推送记录.push({ 谁: 临时.谁, 包: packets.length, 状态: 200 });
      } else if (act === "pull-many") r = await scoped.给多个范围拉取(a, t, b.scopes);
      else r = await scoped.给范围拉取(a, t, String(b.scopeId), Number(b.after));
      return { 状态: 200, json: r as Record<string, unknown> };
    } catch (e) {
      if (e instanceof scoped.范围错误) {
        if (act === "push") 推送记录.push({ 谁: 临时.谁, 包: (b.packets as unknown[]).length, 状态: e.状态 });
        // 和 route.ts 一样带上 denied；模拟旧服务端时不带
        return { 状态: e.状态, json: e.denied && !旧服务端 ? { error: e.message, denied: e.denied } : { error: e.message } };
      }
      throw e;
    }
  }
  return { 状态: 404, json: { error: `fake: ${路径}` } };
};

async function 清空(d: PrismaClient) {
  for (const t of ["AiMessage", "AiConversation", "AiProject", "Setting", "AuditLog", "ImportRow", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerClaim", "CustomerPool"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.user.create({ data: { id: "cmusc55660000dulko96ek8kr", email: "admin", name: "管理员", role: "ADMIN", password: "x", title: "管理员", createdAt: new Date("2026-10-01T00:00:00Z") } });
}
const 轮 = async (w: 谁) => { 当(w); return client.同步一轮(); };
const 都轮 = async (...ws: 谁[]) => { for (const w of ws) expect(await 轮(w)).toMatchObject({ ok: true }); };
const 读配置 = (w: 谁) => { 当(w); return client.读团队()!; };
const A = (w: 谁) => `acct_${账号[w]}`;
const 冲突数 = async (w: 谁) => Number((await db(w).$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM _sync_scope_conflict"))[0].n);
/** 库文件层面：crm.db + crm.db-wal 原始字节里有没有这个串（等同拿十六进制工具翻文件，SQL 查不到的空闲页也算） */
function 文件里有(w: 谁, 串: string) {
  return ["crm.db", "crm.db-wal"].filter((f) => { const p = path.join(临时.root, w, f); return fs.existsSync(p) && fs.readFileSync(p).includes(Buffer.from(串, "utf8")); });
}

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
  for (const w of ["boss", "li", "li2", "zhao"] as const) {
    // li2 是 li 账号的第二台电脑：同一个云端账号
    账号[w] = w === "li2" ? 账号.li : (await control.account.create({ data: { name: w, email: `${w}@example.invalid`, password: "not-a-login" } })).id;
    fs.writeFileSync(path.join(临时.root, w, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: "dk_test", accountId: 账号[w], name: w, contact: `${w}@example.invalid`, models: [], loggedAt: new Date().toISOString() }));
    await 清空(db(w));
  }
  client.设传输(传);
  // 老板建团队、开通、迁移（开关开着：第一轮就迁移）；两位业务员加入
  当("boss");
  const 码 = await client.建团队("交接QA");
  if (!码.ok) throw Error(码.error);
  await relay.设开通(读配置("boss").teamId, true);
  const b = db("boss");
  await b.customer.create({ data: { id: "boss-private", name: "QA老板私客丙", phone: "13900003331", salesOwnerId: A("boss") } });
  await 都轮("boss");
  expect(读配置("boss").scoped?.stage).toBe("ready");
  for (const w of ["li", "li2", "zhao"] as const) { 当(w); expect(await client.加入团队(码.邀请码)).toMatchObject({ ok: true }); }
  await 都轮("li", "li2", "zhao", "boss", "li", "li2", "zhao");
}, 180_000);
afterAll(async () => {
  client?.设传输(null);
  for (const w of ["boss", "li", "li2", "zhao"] as const) await db(w).$disconnect();
  await control?.$disconnect();
  for (const n of ["MULTI_TENANT", "DESKTOP_LOCAL", "SYNC_DIR", "CONTROL_DATABASE_URL", "CRM_DATA_DIR", "CRM_SCOPED_SYNC"]) delete process.env[n];
  fs.rmSync(临时.root, { recursive: true, force: true });
});

const 全轮 = () => 都轮("li", "li2", "zhao", "boss", "li", "li2", "zhao");
const 客 = (w: 谁, id: string) => db(w).customer.findUnique({ where: { id } });
const 在公海 = async (w: 谁, id: string) => !!(await db(w).customerPool.findUnique({ where: { customerId: id } }));
/** 两台 li 上这位客户一样：负责人、在不在公海、跟进条数 */
async function 两台一致(id: string) {
  const 看 = async (w: 谁) => ({ 有: !!(await 客(w, id)), 负责人: (await 客(w, id))?.salesOwnerId ?? null, 公海: await 在公海(w, id), 跟进: await db(w).followUp.count({ where: { customerId: id } }) });
  const [a, b, boss] = [await 看("li"), await 看("li2"), await 看("boss")];
  expect(b).toEqual(a);
  return { li: a, boss };
}
async function 老板放公海(id: string) {
  const b = db("boss");
  await b.customer.create({ data: { id, name: `QA公海${id}`, phone: `139${String(Math.abs([...id].reduce((h, ch) => h * 31 + ch.charCodeAt(0), 7)) % 1e8).padStart(8, "0")}`, salesOwnerId: A("boss") } });
  await b.followUp.create({ data: { id: `${id}-f`, customerId: id, ownerId: A("boss"), type: "PHONE", title: "电话", content: `QA公海跟进${id}` } });
  await b.customerPool.create({ data: { customerId: id, reason: "手动", userId: A("boss") } });
  await 全轮();
  for (const w of ["li", "li2", "zhao"] as const) expect(await 在公海(w, id)).toBe(true);
}
/** 和 pool-actions 领取同一个顺序：先改负责人、写领取、最后删公海 */
async function 领取(w: 谁, id: string) {
  await db(w).$transaction(async (tx) => {
    await tx.customer.update({ where: { id }, data: { salesOwnerId: A(w) } });
    await tx.customerClaim.upsert({ where: { customerId: id }, update: { userId: A(w), at: new Date() }, create: { customerId: id, userId: A(w) } });
    await tx.customerPool.delete({ where: { customerId: id } });
  });
}

describe("范围同步：同一账号的第二台电脑", () => {
  it("li 在第一台领取：第二台也出了公海、归 li（原来公海那一行一直不走）；zhao 那边清掉", async () => {
    await 老板放公海("p1");
    await 领取("li", "p1");
    await 全轮();
    const { li, boss } = await 两台一致("p1");
    expect(li).toMatchObject({ 有: true, 负责人: A("li"), 公海: false, 跟进: 1 });
    expect(boss).toMatchObject({ 负责人: A("li"), 公海: false });
    expect(await 客("zhao", "p1")).toBeNull();
    for (const w of ["li", "li2"] as const) expect(await 冲突数(w)).toBe(0);
  });

  it("撤销领取（先放回公海、再还负责人）：两台 li 都回到公海、归老板；zhao 又收到", async () => {
    await db("li").$transaction(async (tx) => {
      await tx.customerPool.create({ data: { customerId: "p1", userId: A("li"), reason: "手动" } });
      await tx.customer.update({ where: { id: "p1" }, data: { salesOwnerId: A("boss") } });
      await tx.customerClaim.deleteMany({ where: { customerId: "p1" } });
    });
    await 全轮();
    const { li } = await 两台一致("p1");
    expect(li).toMatchObject({ 有: true, 负责人: A("boss"), 公海: true });
    expect(await 在公海("zhao", "p1")).toBe(true);
  });

  it("在第二台领取：第一台跟着变", async () => {
    await 领取("li2", "p1");
    await 全轮();
    const { li } = await 两台一致("p1");
    expect(li).toMatchObject({ 负责人: A("li"), 公海: false });
    expect(await 客("zhao", "p1")).toBeNull();
  });

  it("li 交给 zhao（带计划）：第二台也清掉、字节不留；zhao 收到", async () => {
    const l = db("li");
    await l.customer.create({ data: { id: "h1", name: "QA交出去的", phone: "13900005511", salesOwnerId: A("li") } });
    await l.followPlan.create({ data: { id: "h1-p", customerId: "h1", ownerId: A("li"), subject: "QA计划", plannedAt: new Date(Date.now() + 86_400_000) } });
    await 全轮();
    expect(await 客("li2", "h1")).not.toBeNull();
    await l.customer.update({ where: { id: "h1" }, data: { salesOwnerId: A("zhao") } });
    await l.followPlan.update({ where: { id: "h1-p" }, data: { ownerId: A("zhao") } });
    await 全轮();
    for (const w of ["li", "li2"] as const) {
      expect(await 客(w, "h1")).toBeNull();
      expect(文件里有(w, "13900005511")).toEqual([]);
    }
    expect((await db("zhao").followPlan.findUnique({ where: { id: "h1-p" } }))?.ownerId).toBe(A("zhao"));
    for (const w of ["li", "li2"] as const) expect(await 冲突数(w)).toBe(0);
  });

  it("zhao 交给 li、老板批量改负责人给 li：两台 li 都收到（带跟进 / 计划）", async () => {
    await db("zhao").customer.update({ where: { id: "h1" }, data: { salesOwnerId: A("li") } });
    const b = db("boss");
    await b.customer.create({ data: { id: "b1", name: "QA老板分的", phone: "13900005522", salesOwnerId: A("boss") } });
    await b.followUp.create({ data: { id: "b1-f", customerId: "b1", ownerId: A("boss"), type: "PHONE", title: "电话", content: "QA老板的跟进" } });
    await 全轮();
    await b.customer.update({ where: { id: "b1" }, data: { salesOwnerId: A("li") } });
    await 全轮();
    for (const id of ["h1", "b1"]) expect((await 两台一致(id)).li).toMatchObject({ 有: true, 负责人: A("li") });
    expect(await db("li2").followPlan.findUnique({ where: { id: "h1-p" } })).not.toBeNull();
    expect(await db("li2").followUp.findUnique({ where: { id: "b1-f" } })).not.toBeNull();
  });

  it("li 把自己的客户放进公海：第二台、zhao 都看到在公海", async () => {
    await db("li").customerPool.create({ data: { customerId: "b1", userId: A("li"), reason: "手动" } });
    await 全轮();
    expect((await 两台一致("b1")).li).toMatchObject({ 公海: true });
    expect(await 在公海("zhao", "b1")).toBe(true);
  });

  it("删除：第一台删跟进、删客户，第二台跟着删", async () => {
    await db("li").followUp.delete({ where: { id: "b1-f" } });
    await 全轮();
    expect(await db("li2").followUp.findUnique({ where: { id: "b1-f" } })).toBeNull();
    await db("li").customerPool.delete({ where: { customerId: "b1" } });
    await db("li").customer.delete({ where: { id: "b1" } });
    await 全轮();
    for (const w of ["li", "li2", "boss", "zhao"] as const) expect(await 客(w, "b1")).toBeNull();
  });

  it("已经卡住的设备（游标早过了删除包、本机还留着公海那一行）：下一轮照目录补删除", async () => {
    const d = db("li2");
    await d.$executeRawUnsafe("UPDATE _sync_state SET applying = 1 WHERE id = 1");
    await d.customerPool.create({ data: { customerId: "p1", reason: "手动" } });
    await d.$executeRawUnsafe("UPDATE _sync_state SET applying = 0 WHERE id = 1");
    await 都轮("li2");
    expect(await 在公海("li2", "p1")).toBe(false);
    expect((await 客("li2", "p1"))?.salesOwnerId).toBe(A("li"));
  });

  it("删除包夹带内容：接收端拒收", async () => {
    const { 验收范围包, 范围包错误 } = await import("@/lib/sync/scoped-local");
    const { 封范围 } = await import("@/lib/sync/crypto");
    const cfg = 读配置("li");
    const meta = { t: "FollowUp", k: "x", o: "D" as const, h: "1760000000000-x", fields: {} };
    const change = { t: "FollowUp", k: "x", o: "D" as const, r: { content: "夹带" }, c: [], h: meta.h };
    const eventId = "c".repeat(64);
    const data = 封范围({ meta, change }, cfg.key, cfg.epoch ?? 0, { teamId: cfg.teamId, device: "dx", eventId, meta });
    const idx = { t: "FollowUp", k: "x", fields: {}, clocks: {}, deleted: true, clock: meta.h, routeSeq: 0 };
    expect(() => 验收范围包({ seq: 1, device: "dx", eventId, meta, data }, { [String(cfg.epoch ?? 0)]: cfg.key }, cfg.teamId, idx, new Set(["FollowUp:x"]))).toThrow(范围包错误);
  });
});
