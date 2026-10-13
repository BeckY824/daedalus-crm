/** 接收端核对（验收范围包）与业务员本机清理（清理失权副本）的单测；只用临时拷贝的 SQLite，不碰真实库。 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@/generated/prisma";
import { 新钥匙, 封范围 } from "@/lib/sync/crypto";
import { 提取范围, 合并范围, 行键 } from "@/lib/sync/scope-policy";
import { 验收范围包, 范围包错误, 清理失权副本, 范围冲突数 } from "@/lib/sync/scoped-local";
import { 建同步表, 装触发器, 待推 } from "@/lib/sync/local";
import type { 改动 } from "@/lib/sync/local";

const key = 新钥匙(), teamId = "teamscope", device = "dpusher";
const ev = (t: string, k: string, r: Record<string, unknown>, o: 改动["o"] = "I", c = Object.keys(r)): 改动 => ({ t, k, o, r: o === "D" ? null : r, c, h: `1760000000000-${device}` });
function 包(e: 改动, over: Partial<{ meta: ReturnType<typeof 提取范围>; innerMeta: ReturnType<typeof 提取范围>; eventId: string }> = {}) {
  const meta = over.meta ?? 提取范围(e), eventId = over.eventId ?? "a".repeat(64);
  return { seq: 1, device, eventId, meta, data: 封范围({ meta: over.innerMeta ?? meta, change: e }, key, 0, { teamId, device, eventId, meta }) };
}
const idx = (e: 改动) => 合并范围(undefined, 提取范围(e), 1);

describe("验收范围包", () => {
  const own = ev("Customer", "own", { id: "own", salesOwnerId: "acct_m", name: "自有" });
  const allowed = new Set([行键("Customer", "own")]);
  it("正常包通过，路由字段按服务端当前值归一化", () => {
    const cur = { ...idx(own), fields: { salesOwnerId: "acct_m", channelOwnerId: null } };
    expect(验收范围包(包(own), { "0": key }, teamId, cur, allowed).r).toMatchObject({ name: "自有", salesOwnerId: "acct_m" });
  });
  it("中转篡改外层元数据 / 换设备 / 换 eventId：解不开", () => {
    const p = 包(own);
    expect(() => 验收范围包({ ...p, meta: { ...p.meta, k: "boss" } }, { "0": key }, teamId, idx(own), allowed)).toThrow(范围包错误);
    expect(() => 验收范围包({ ...p, device: "dother" }, { "0": key }, teamId, idx(own), allowed)).toThrow(范围包错误);
    expect(() => 验收范围包({ ...p, eventId: "b".repeat(64) }, { "0": key }, teamId, idx(own), allowed)).toThrow(范围包错误);
  });
  it("推送者外层写本人客户、内层改老板私客：拒收", () => {
    const boss = ev("Customer", "boss", { id: "boss", salesOwnerId: "acct_b", name: "私客" });
    const p = 包(boss, { meta: 提取范围(own) });
    expect(() => 验收范围包(p, { "0": key }, teamId, idx(own), allowed)).toThrow(范围包错误);
  });
  it("不在本机范围、父链指向隐藏客户：拒收", () => {
    const boss = ev("Customer", "boss", { id: "boss", salesOwnerId: "acct_b" });
    expect(() => 验收范围包(包(boss), { "0": key }, teamId, idx(boss), allowed)).toThrow(范围包错误);
    const contact = ev("Contact", "c1", { id: "c1", customerId: "boss", name: "x" });
    const cur = idx(contact);
    expect(() => 验收范围包(包(contact), { "0": key }, teamId, cur, new Set([...allowed, 行键("Contact", "c1")]))).toThrow(/不在本机同步范围/);
  });
  it("缺钥匙不是坏包：原样抛出，游标不越过", () => {
    expect(() => 验收范围包(包(own), { "7": key }, teamId, idx(own), allowed)).toThrow(/没有 0 号钥匙/);
  });
});

describe("清理失权副本", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-scoped-local-"));
  let db: PrismaClient;
  beforeAll(async () => {
    fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(dir, "t.db"));
    if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(dir, "t.db-wal"));
    db = new PrismaClient({ datasourceUrl: `file:${path.join(dir, "t.db")}` });
    for (const t of ["AiMessage", "AiConversation", "Setting", "AuditLog", "ImportRow", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerPool"]) await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
    await db.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
    await db.$executeRawUnsafe('DELETE FROM "Customer"');
    for (const id of ["acct_m", "acct_b"]) await db.user.upsert({ where: { id }, create: { id, email: `${id}@x`, name: id, password: "x" }, update: {} });
    await 建同步表(db); await 装触发器(db);
  });
  afterAll(async () => { await db.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });
  it("删失权客户及子记录、日志整行、导入撤销快照、推荐人外键；保留本人数据；AI 历史只统计不删", async () => {
    await db.customer.create({ data: { id: "mine", name: "本人客户", phone: "1", salesOwnerId: "acct_m" } });
    await db.customer.create({ data: { id: "hidden", name: "隐藏私客", phone: "13900001611", salesOwnerId: "acct_b" } });
    await db.customer.update({ where: { id: "mine" }, data: { referrerCustomerId: "hidden" } });
    await db.contact.create({ data: { id: "hc", name: "隐藏联系人", customerId: "hidden" } });
    await db.importBatch.create({ data: { id: "ib", userId: "acct_m", userName: "m", fileName: "f.xlsx", rows: { create: [{ customerId: "hidden", kind: "create" }, { customerId: "mine", kind: "create" }] } } });
    await db.aiConversation.create({ data: { id: "ai1", title: "问", ownerId: "acct_m", messages: { create: [{ role: "assistant", text: "答", refs: JSON.stringify([{ id: "hidden" }]) }] } } });
    await 待推(db, "dm"); // 编钟
    await db.$executeRawUnsafe("INSERT OR REPLACE INTO _sync_cursor (k, v) VALUES ('pushed', (SELECT MAX(seq) FROM _sync_log))");
    const r = await 清理失权副本(db, new Set([行键("Customer", "mine")]));
    expect(r).toMatchObject({ 冲突: 0, AI残留: 1 });
    expect(await db.customer.findUnique({ where: { id: "hidden" } })).toBeNull();
    expect(await db.contact.count()).toBe(0);
    expect((await db.customer.findUnique({ where: { id: "mine" } }))?.referrerCustomerId).toBeNull();
    expect(await db.importRow.count()).toBe(1);
    const log = await db.$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM _sync_log WHERE row LIKE '%隐藏%' OR pk = 'hidden'");
    expect(Number(log[0].n)).toBe(0);
    expect(await db.aiMessage.count()).toBe(1);
    // 清理本身不进推送队列
    const pend = await db.$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM _sync_log WHERE seq > (SELECT v FROM _sync_cursor WHERE k='pushed') AND op = 'D'");
    expect(Number(pend[0].n)).toBe(0);
  });
  it("失权记录的未上传改动转成冲突，只留改动列；本人未上传的保留在队列", async () => {
    await db.customer.create({ data: { id: "lost2", name: "将失权", phone: "2", salesOwnerId: "acct_m" } });
    await db.$executeRawUnsafe("INSERT OR REPLACE INTO _sync_cursor (k, v) VALUES ('pushed', (SELECT MAX(seq) FROM _sync_log))");
    await db.customer.update({ where: { id: "lost2" }, data: { remark: "我的改动" } });
    await db.customer.update({ where: { id: "mine" }, data: { remark: "本人未推" } });
    const r = await 清理失权副本(db, new Set([行键("Customer", "mine")]));
    expect(r.冲突).toBe(1);
    expect(await 范围冲突数(db)).toBe(1);
    const c = await db.$queryRawUnsafe<{ row: string }[]>("SELECT row FROM _sync_scope_conflict");
    expect(JSON.parse(c[0].row)).toMatchObject({ remark: "我的改动" });
    expect(c[0].row).not.toContain("将失权");
    const pend = await db.$queryRawUnsafe<{ pk: string }[]>("SELECT pk FROM _sync_log WHERE seq > (SELECT v FROM _sync_cursor WHERE k='pushed')");
    expect(pend.map(p => p.pk)).toEqual(["mine"]);
  });
});
