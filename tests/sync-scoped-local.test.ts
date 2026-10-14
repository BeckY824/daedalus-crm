/** 接收端核对（验收范围包）与业务员本机清理（清理失权副本）的单测；只用临时拷贝的 SQLite，不碰真实库。 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { PrismaClient } from "@/generated/prisma";
import { 新钥匙, 封范围 } from "@/lib/sync/crypto";
import { 提取范围, 合并范围, 行键 } from "@/lib/sync/scope-policy";
import { 验收范围包, 范围包错误, 清理失权副本, 范围冲突数, 列出范围冲突, 确认范围冲突, 导出范围冲突, 擦净删除残留, 擦净等锁毫秒 } from "@/lib/sync/scoped-local";
import { 冲突导出文件名 } from "@/app/(app)/settings/scope-conflicts-file";
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
  it("推完到清理之间刚建、还没推上去的本人记录不算失权（不删、不转冲突，下一轮照常推）；挂在失权客户下的新建照样转冲突（2026-10-14）", async () => {
    await db.customer.create({ data: { id: "lost3", name: "又将失权", phone: "3", salesOwnerId: "acct_m" } });
    await 待推(db, "dm");
    await db.$executeRawUnsafe("INSERT OR REPLACE INTO _sync_cursor (k, v) VALUES ('pushed', (SELECT MAX(seq) FROM _sync_log))");
    const 冲突前 = Number((await db.$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM _sync_scope_conflict"))[0].n);
    // 目录取完之后人又录了：一位新客户（带操作日志、跟进），以及在将失权客户下的一条跟进
    await db.customer.create({ data: { id: "fresh", name: "刚录的", phone: "4", salesOwnerId: "acct_m" } });
    await db.auditLog.create({ data: { id: "fresh-a", userId: "acct_m", userName: "m", action: "create", entity: "Customer", entityId: "fresh", summary: "新建 刚录的" } });
    await db.followUp.create({ data: { id: "fresh-f", customerId: "fresh", ownerId: "acct_m", type: "PHONE", title: "电话", content: "刚录的跟进" } });
    await db.followUp.create({ data: { id: "lost3-f", customerId: "lost3", ownerId: "acct_m", type: "PHONE", title: "电话", content: "失权客户下新记的" } });
    const r = await 清理失权副本(db, new Set([行键("Customer", "mine")]));
    expect(await db.customer.findUnique({ where: { id: "fresh" } })).not.toBeNull();
    expect(await db.followUp.findUnique({ where: { id: "fresh-f" } })).not.toBeNull();
    expect(await db.auditLog.findUnique({ where: { id: "fresh-a" } })).not.toBeNull();
    expect(await db.customer.findUnique({ where: { id: "lost3" } })).toBeNull();
    expect(await db.followUp.findUnique({ where: { id: "lost3-f" } })).toBeNull();
    expect(r.冲突).toBe(1);
    const c = await db.$queryRawUnsafe<{ pk: string }[]>("SELECT pk FROM _sync_scope_conflict ORDER BY id DESC LIMIT 1");
    expect(c[0].pk).toBe("lost3-f");
    expect(Number((await db.$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM _sync_scope_conflict"))[0].n)).toBe(冲突前 + 1);
    const pend = await db.$queryRawUnsafe<{ pk: string }[]>("SELECT DISTINCT pk FROM _sync_log WHERE seq > (SELECT v FROM _sync_cursor WHERE k='pushed')");
    expect(pend.map(p => p.pk).sort()).toEqual(["fresh", "fresh-a", "fresh-f"]);
    // 收尾：这几条推上去了（进了目录）之后不影响后面的用例
    await db.$executeRawUnsafe("DELETE FROM _sync_scope_conflict WHERE pk = 'lost3-f'");
  });
  it("冲突列表：失权记录只显示本人改过的值或编号；确认只标记不删除；导出含全部", async () => {
    const list = await 列出范围冲突(db);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ 表: "客户", 编号: "lost2", 名称: "lost2", 操作: "修改", 改动列: expect.arrayContaining(["remark"]), 已确认: null });
    expect(JSON.stringify(list)).not.toContain("将失权");
    expect(await 确认范围冲突(db, [list[0].id])).toBe(1);
    expect(await 确认范围冲突(db, [list[0].id])).toBe(0);
    expect(await 列出范围冲突(db)).toHaveLength(0);
    expect(await 范围冲突数(db)).toBe(0);
    expect(await 列出范围冲突(db, true)).toHaveLength(1);
    const out = JSON.parse(await 导出范围冲突(db));
    expect(out.条目).toHaveLength(1);
    expect(out.条目[0]).toMatchObject({ 编号: "lost2", 改动内容: { remark: "我的改动" } });
    expect(out.条目[0].已确认).not.toBeNull();
    expect(Number((await db.$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM _sync_scope_conflict"))[0].n)).toBe(1);
    expect(冲突导出文件名(new Date(2026, 9, 13))).toBe("同步权限冲突-20261013.json");
  });
  it("旧草稿建的冲突表（无 resolvedAt）自动补列", async () => {
    await db.$executeRawUnsafe("ALTER TABLE _sync_scope_conflict RENAME TO _old_conflict");
    await db.$executeRawUnsafe("CREATE TABLE _sync_scope_conflict (id INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, pk TEXT NOT NULL, op TEXT NOT NULL, row TEXT, changed TEXT NOT NULL, at BIGINT NOT NULL, reason TEXT NOT NULL, createdAt BIGINT NOT NULL)");
    await db.$executeRawUnsafe("INSERT INTO _sync_scope_conflict (tbl, pk, op, row, changed, at, reason, createdAt) VALUES ('Customer','x','U','{\"name\":\"本人改名\"}','name',0,'r',0)");
    const l = await 列出范围冲突(db);
    expect(l[0]).toMatchObject({ 名称: "本人改名", 已确认: null });
  });
});

/*
  Windows 上别的程序（杀毒、备份、索引）拿着库文件时，清理后的整库重建不能把桌面端卡住（2026-10-14，候选 7 Windows CI 复查）：
  原来 checkpoint 撞上别的读者按连接的等锁时长（5 秒）等，四次重试最坏二十几秒，桌面端只有一个连接，这期间全软件读写排队。
  现在等锁最多 1 秒、总预算有限，等不到就记「欠擦」下一轮补，连接原来的等锁时长恢复原样。
*/
describe("擦净删除残留：库文件被别人占着时有限等待、记欠擦，放开后补擦", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-scoped-wipe-"));
  const f = path.join(dir, "w.db");
  let db: PrismaClient;
  beforeAll(async () => {
    fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), f);
    db = new PrismaClient({ datasourceUrl: `file:${f}?connection_limit=1` });
    await db.$queryRawUnsafe("PRAGMA journal_mode = WAL");
    await 建同步表(db);
  });
  afterAll(async () => {
    await db.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const 欠着 = async () => (await db.$queryRawUnsafe<unknown[]>("SELECT 1 FROM _sync_cursor WHERE k = 'wipe_pending'")).length > 0;

  it("别的程序开着读事务：按预算放弃、记欠擦、不长等，等锁时长恢复；放开后下一次擦净并清掉欠擦", async () => {
    // 别的程序（备份、只读工具）拿着一个读快照不放：WAL 下 checkpoint(TRUNCATE) 截不了。
    // 必须是另一个进程：同一进程里 Prisma 和 node:sqlite 是两份 SQLite，Unix 上互相看不见对方的文件锁
    const 别人 = spawn(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const d = new DatabaseSync(process.argv[1]);
      d.exec("BEGIN"); d.prepare("SELECT count(*) AS n FROM Customer").get();
      process.stdout.write("ready\\n");
      process.stdin.on("data", () => { d.exec("COMMIT"); d.close(); process.exit(0); });
    `, f], { stdio: ["pipe", "pipe", "inherit"] });
    const 走了 = new Promise((ok) => 别人.on("exit", ok));
    try {
      await new Promise<void>((ok, no) => { 别人.stdout!.once("data", () => ok()); 别人.once("error", no); });
      await db.$executeRawUnsafe("INSERT INTO _sync_cursor (k, v) VALUES ('wipe_test', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1"); // WAL 里有那个读者之后的新页
      const 起 = Date.now();
      expect(await 擦净删除残留(db, 2_000)).toBe(false);
      const 用了 = Date.now() - 起;
      expect(用了, `撞锁不长等（原来最坏 4×5.5 秒），这次 ${用了}ms`).toBeLessThan(2_000 + 擦净等锁毫秒 + 3_000);
      expect(await 欠着(), "没擦净要记欠擦，下一轮补").toBe(true);
      expect(Number((await db.$queryRawUnsafe<{ timeout: bigint }[]>("PRAGMA busy_timeout"))[0].timeout), "连接原来的等锁时长恢复").toBe(5000);
    } finally {
      别人.stdin!.write("go\n");
      await 走了;
    }
    expect(await 擦净删除残留(db)).toBe(true);
    expect(await 欠着()).toBe(false);
    expect(fs.statSync(`${f}-wal`).size, "WAL 截成 0 字节").toBe(0);
  }, 30_000);
});
