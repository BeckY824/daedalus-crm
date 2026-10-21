/**
 * 合并疑似重复客户（2026-10-20，lib/customer-merge.ts + 本机回放那一半 lib/sync/local.ts）。
 *   - 合并：子记录挪到留下那份，空着的字段补上、有值的不改，负责人不变，写合并记号，删掉多的那份
 *   - 撤销一次：拆回两份、挪回去、补的清回空；撤过就没得撤了
 *   - 两台同步：合并那台推出去，另一台变成一份；离线那台改了被合并的那份、又记了跟进，回来后不会把它推回来，
 *     新记的跟进挂到留下那份上
 *   - 疑似重复列表：默认留跟进多的，一样多留先建的；标了「不是同一个人」就不再列
 * 两份独立的库拷自测试库（和 sync-local 一样），不碰共用的测试库；疑似重复那组用共用测试库，号码各用各的。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@/generated/prisma";
import { 改身份, 建同步表, 装触发器, 记全量, 待推, 记已推, 回放 } from "@/lib/sync/local";
import { 封, 拆, 新钥匙 } from "@/lib/sync/crypto";
import { 合并一批, 撤销上一批, 读上次合并, 标不是同一个人, 不重复编号 } from "@/lib/customer-merge";
import { 默认留, 疑似重复 } from "@/lib/sync/dupes";
import { prisma } from "@/lib/prisma";

const 测试库 = path.resolve(__dirname, "../prisma/test.db");
const 老板 = "cmusc55660000dulko96ek8kr", 王 = "cmusc55680001dulki71dcsts";
let 目录: string;
const 开着: PrismaClient[] = [];

async function 一台(名: string): Promise<PrismaClient> {
  const f = path.join(目录, `${名}.db`);
  fs.copyFileSync(测试库, f);
  if (fs.existsSync(`${测试库}-wal`)) fs.copyFileSync(`${测试库}-wal`, `${f}-wal`);
  const db = new PrismaClient({ datasourceUrl: `file:${f}?connection_limit=1` });
  开着.push(db);
  await db.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  for (const t of ["CustomerMerge", "CustomerNotDupe", "AiConversation", "AiProject", "Setting", "AuditLog", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerExtra", "CustomerPool", "CustomerClaim"]) {
    await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
  }
  await db.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
  const 那时 = new Date("2026-10-01T00:00:00Z");
  await db.user.create({ data: { id: 老板, email: "admin", name: "老板", role: "ADMIN", password: "x", createdAt: 那时 } });
  await db.user.create({ data: { id: 王, email: "wang", name: "王业务", role: "SALES", password: "x", createdAt: 那时 } });
  return db;
}

beforeEach(() => { 目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-merge-")); });
afterEach(async () => {
  for (const db of 开着.splice(0)) await db.$disconnect();
  fs.rmSync(目录, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  delete process.env.CRM_DATA_DIR;
});

/** 老板那份 Y（两条跟进、有备注）+ 王业务那份 X（同号码、一条跟进、有专业和联系人、外贸档案） */
async function 一对重复(db: PrismaClient) {
  const Y = await db.customer.create({ data: { name: "李总", phone: "13900002001", remark: "老板录的", salesOwnerId: 老板, createdAt: new Date("2026-10-02T00:00:00Z") } });
  const X = await db.customer.create({ data: { name: "李总（王）", phone: "13900002001", remark: "王录的", major: "包装", salesOwnerId: 王, createdAt: new Date("2026-10-05T00:00:00Z") } });
  for (const [c, n] of [[Y, 2], [X, 1]] as const) for (let i = 0; i < n; i++) await db.followUp.create({ data: { type: "PHONE", title: `${c.name} 跟进 ${i}`, content: "x", customerId: c.id, ownerId: c.salesOwnerId!, occurredAt: new Date(`2026-10-1${i}T08:00:00Z`) } });
  await db.contact.create({ data: { name: "王的联系人", customerId: X.id, isPrimary: true } });
  await db.contact.create({ data: { name: "老板的联系人", customerId: Y.id, isPrimary: true } });
  await db.opportunity.create({ data: { name: "X 的商机", customerId: X.id, ownerId: 王 } });
  await db.customerExtra.create({ data: { customerId: X.id, email: "li@x.com", country: "CN" } });
  // 别的客户的推荐人是 X：合并后改指 Y
  const 被荐 = await db.customer.create({ data: { name: "被推荐的", phone: "", salesOwnerId: 王, referrerCustomerId: X.id } });
  return { X, Y, 被荐 };
}

describe("合并 + 撤销（一台）", () => {
  it("挪过去、补空格不覆盖、负责人不变、写记号、删多的；撤销一次拆回两份", async () => {
    const db = await 一台("one");
    process.env.CRM_DATA_DIR = 目录;
    const { X, Y, 被荐 } = await 一对重复(db);
    const r = await 合并一批([{ 留: Y.id, 并: X.id }], { id: 老板 }, db);
    expect(r.没合).toEqual([]);
    expect(r.备份).toMatch(/^before-merge-\d{4}-\d{2}-\d{2}-\d{4}-[0-9a-f]{6}\.db$/);
    expect(fs.existsSync(path.join(目录, "backups", r.备份!))).toBe(true);

    expect(await db.customer.findUnique({ where: { id: X.id } })).toBeNull();
    const y = await db.customer.findUniqueOrThrow({ where: { id: Y.id } });
    expect(y).toMatchObject({ salesOwnerId: 老板, remark: "老板录的", major: "包装", phone: "13900002001" });
    expect(y.lastFollowAt?.toISOString()).toBe("2026-10-11T08:00:00.000Z");
    expect(await db.followUp.count({ where: { customerId: Y.id } })).toBe(3);
    expect(await db.opportunity.count({ where: { customerId: Y.id } })).toBe(1);
    // 关键联系人只留一个：老板那份原来的
    expect((await db.contact.findMany({ where: { customerId: Y.id }, orderBy: { name: "asc" } })).map((c) => [c.name, c.isPrimary])).toEqual([["王的联系人", false], ["老板的联系人", true]]);
    expect(await db.customerExtra.findUnique({ where: { customerId: Y.id } })).toMatchObject({ email: "li@x.com", country: "CN" });
    expect(await db.customerExtra.findUnique({ where: { customerId: X.id } })).toBeNull();
    expect((await db.customer.findUniqueOrThrow({ where: { id: 被荐.id } })).referrerCustomerId).toBe(Y.id);
    expect(await db.customerMerge.findUniqueOrThrow({ where: { id: X.id } })).toMatchObject({ fromId: X.id, intoId: Y.id, fromOwnerName: "王业务", userId: 老板 });
    expect(await db.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check")).toEqual([]);
    expect((await 读上次合并(db))?.料们).toHaveLength(1);

    const u = await 撤销上一批(db);
    expect(u.没撤).toEqual([]);
    expect(await db.customer.findUniqueOrThrow({ where: { id: X.id } })).toMatchObject({ name: "李总（王）", salesOwnerId: 王, remark: "王录的", major: "包装" });
    expect((await db.customer.findUniqueOrThrow({ where: { id: X.id } })).createdAt.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(await db.customer.findUniqueOrThrow({ where: { id: Y.id } })).toMatchObject({ major: null, remark: "老板录的" });
    expect(await db.followUp.count({ where: { customerId: X.id } })).toBe(1);
    expect(await db.followUp.count({ where: { customerId: Y.id } })).toBe(2);
    expect(await db.contact.findFirstOrThrow({ where: { name: "王的联系人" } })).toMatchObject({ customerId: X.id, isPrimary: true });
    expect(await db.customerExtra.findUnique({ where: { customerId: X.id } })).toMatchObject({ email: "li@x.com" });
    expect(await db.customerExtra.findUnique({ where: { customerId: Y.id } })).toBeNull();
    expect((await db.customer.findUniqueOrThrow({ where: { id: 被荐.id } })).referrerCustomerId).toBe(X.id);
    expect(await db.customerMerge.count()).toBe(0);
    // 只能撤一次
    expect(await 读上次合并(db)).toBeNull();
    expect(await 撤销上一批(db)).toEqual({ 撤了: [], 没撤: [] });
  });

  it("一批里有一对已经不在了：别的照合，没合的报出来", async () => {
    const db = await 一台("batch");
    const { X, Y } = await 一对重复(db);
    const r = await 合并一批([{ 留: Y.id, 并: "不在的" }, { 留: Y.id, 并: X.id }], { id: 老板 }, db);
    expect(r.合了).toHaveLength(1);
    expect(r.没合).toHaveLength(1);
    expect(r.没合[0].原因).toMatch(/不在了/);
    expect(r.备份).toBeNull(); // 没有 CRM_DATA_DIR（网页 / 测试）不备份
  });
});

describe("两台同步", () => {
  const 钥匙 = 新钥匙();
  async function 推(db: PrismaClient, 设备: string) {
    const { 改动: 批, 到 } = await 待推(db, 设备);
    if (!批.length) return null;
    await 记已推(db, 到);
    return 封(批, 钥匙);
  }
  async function 进团队(db: PrismaClient, 账号: string) {
    await 改身份(db, 账号 === "boss" ? 老板 : 王, { email: 账号, name: 账号 });
    await 建同步表(db); await 装触发器(db); await 记全量(db);
  }

  it("老板合并，王那台离线时改了 X、给 X 记了跟进：回来后各台都只剩 Y，王新记的跟进挂到 Y 上，X 不会回来", async () => {
    const A = await 一台("A"), B = await 一台("B");
    for (const db of [A, B]) { await 建同步表(db); await 装触发器(db); }
    const { X, Y } = await 一对重复(A);
    const 首 = await 推(A, "A");
    await 回放(B, 拆(首!, 钥匙), "B");
    expect(await B.customer.count({ where: { phone: "13900002001" } })).toBe(2);

    // 王那台离线：改 X 的备注、给 X 记一条跟进
    await B.customer.update({ where: { id: X.id }, data: { remark: "离线时改的" } });
    const 离线跟进 = await B.followUp.create({ data: { type: "PHONE", title: "离线记的", content: "x", customerId: X.id, ownerId: 王 } });

    // 老板这台合并
    await 合并一批([{ 留: Y.id, 并: X.id }], { id: 老板 }, A);
    const a = await 推(A, "A");
    // 王回来：先推自己的，再拉老板的
    const b = await 推(B, "B");
    await 回放(A, 拆(b!, 钥匙), "A");
    await 回放(B, 拆(a!, 钥匙), "B");

    for (const db of [A, B]) {
      expect(await db.customer.findUnique({ where: { id: X.id } }), "X 不该回来").toBeNull();
      expect(await db.customer.count({ where: { phone: "13900002001" } })).toBe(1);
      expect(await db.followUp.findUniqueOrThrow({ where: { id: 离线跟进.id } })).toMatchObject({ customerId: Y.id });
      expect(await db.followUp.count({ where: { customerId: Y.id } })).toBe(4);
      expect(await db.contact.count({ where: { customerId: Y.id } })).toBe(2);
      expect(await db.customerMerge.count()).toBe(1);
      expect(await db.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check")).toEqual([]);
    }
    // 再来一轮：B 把挪过的跟进推出去，A 照收；谁都不会把 X 建回来
    const b2 = await 推(B, "B");
    if (b2) await 回放(A, 拆(b2, 钥匙), "A");
    const a2 = await 推(A, "A");
    if (a2) await 回放(B, 拆(a2, 钥匙), "B");
    for (const db of [A, B]) expect(await db.customer.findUnique({ where: { id: X.id } })).toBeNull();
  });

  it("撤销合并也同步：另一台拆回两份", async () => {
    const A = await 一台("A2"), B = await 一台("B2");
    for (const db of [A, B]) { await 建同步表(db); await 装触发器(db); }
    const { X, Y } = await 一对重复(A);
    await 回放(B, 拆((await 推(A, "A"))!, 钥匙), "B");
    await 合并一批([{ 留: Y.id, 并: X.id }], { id: 老板 }, A);
    await 回放(B, 拆((await 推(A, "A"))!, 钥匙), "B");
    expect(await B.customer.findUnique({ where: { id: X.id } })).toBeNull();
    await 撤销上一批(A);
    await 回放(B, 拆((await 推(A, "A"))!, 钥匙), "B");
    expect(await B.customer.findUniqueOrThrow({ where: { id: X.id } })).toMatchObject({ salesOwnerId: 王, remark: "王录的" });
    expect(await B.followUp.count({ where: { customerId: X.id } })).toBe(1);
    expect(await B.customer.findUniqueOrThrow({ where: { id: Y.id } })).toMatchObject({ major: null });
    expect(await B.customerMerge.count()).toBe(0);
  });

  it("进团队前就有的两份（记全量）也能合：标了「不是同一个人」也同步过去", async () => {
    const A = await 一台("A3"), B = await 一台("B3");
    const { X, Y } = await 一对重复(A);
    await 进团队(A, "boss"); await 进团队(B, "wang");
    await 回放(B, 拆((await 推(A, "A"))!, 钥匙), "B");
    await 标不是同一个人([X.id, Y.id], { id: 老板 }, A);
    await 回放(B, 拆((await 推(A, "A"))!, 钥匙), "B");
    expect(await B.customerNotDupe.findUniqueOrThrow({ where: { id: 不重复编号(X.id, Y.id) } })).toMatchObject({ userId: 老板 });
  });
});

describe("疑似重复列表", () => {
  it("默认留：跟进多的；一样多留先建的", () => {
    const r = (id: string, 跟进: number, 建档: string) => ({ id, name: id, href: "", 谁的: null, 跟进, 建档 });
    expect(默认留([r("a", 1, "2026-10-01"), r("b", 3, "2026-10-05")])).toBe("b");
    expect(默认留([r("a", 2, "2026-10-05"), r("b", 2, "2026-10-01")])).toBe("b");
  });

  it("同号码列出来，带跟进条数和默认留哪份；标了「不是同一个人」就不再列", async () => {
    const 号 = `139${Date.now().toString().slice(-8)}`;
    const 人 = (await prisma.user.create({ data: { email: `dupe-${号}`, name: "列表人", password: "x", role: "ADMIN" } })).id;
    const a = await prisma.customer.create({ data: { name: "列表甲", phone: 号, salesOwnerId: 人, createdAt: new Date("2026-10-01T00:00:00Z") } });
    const b = await prisma.customer.create({ data: { name: "列表乙", phone: 号, salesOwnerId: 人, createdAt: new Date("2026-10-03T00:00:00Z") } });
    try {
      await prisma.followUp.create({ data: { type: "PHONE", title: "x", content: "x", customerId: b.id, ownerId: 人 } });
      const 组 = (await 疑似重复()).find((g) => g.记录.some((x) => x.id === a.id));
      expect(组?.记录.map((x) => [x.name, x.跟进])).toEqual(expect.arrayContaining([["列表甲", 0], ["列表乙", 1]]));
      expect(组?.留).toBe(b.id);
      expect(组?.记录.find((x) => x.id === b.id)?.最近跟进).toBeTruthy(); // 按跟进现算，不靠 lastFollowAt
      expect(组?.记录.find((x) => x.id === a.id)?.最近跟进).toBeNull();
      expect(组?.记录.find((x) => x.id === a.id)?.建档).toBe("2026-10-01T00:00:00.000Z");
      await 标不是同一个人([a.id, b.id], { id: 人 });
      expect((await 疑似重复()).find((g) => g.记录.some((x) => x.id === a.id))).toBeUndefined();
    } finally {
      await prisma.customerNotDupe.deleteMany({ where: { customerId: { in: [a.id, b.id] } } });
      await prisma.followUp.deleteMany({ where: { customerId: { in: [a.id, b.id] } } });
      await prisma.customer.deleteMany({ where: { id: { in: [a.id, b.id] } } });
      await prisma.user.deleteMany({ where: { id: 人 } });
    }
  });
});
