/**
 * 团队同步 · 本机这一半（2026-10-03，0.46.15 第 5 块）。探针（~/CRM/团队同步探针-2026-10-03.md）的场景搬成单测：
 * 两份独立的库（拷一份测试库，同样种上模板那三个固定账号），走「改身份 → 建表装触发器 → 记全量 → 推 → 加密 → 拉 → 回放」。
 * 下划线表和触发器只装在这两份拷贝上，碰不到共用的测试库。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@/generated/prisma";
import { 改身份, 建同步表, 装触发器, 记全量, 待推, 记已推, 回放, 装了吗, type 改动 } from "@/lib/sync/local";
import { 封, 拆, 新钥匙 } from "@/lib/sync/crypto";

const 测试库 = path.resolve(__dirname, "../prisma/test.db");
const 模板账号 = [
  { id: "cmusc55660000dulko96ek8kr", email: "admin", name: "管理员", role: "ADMIN" },
  { id: "cmusc55680001dulki71dcsts", email: "zhangsan", name: "张三", role: "SALES" },
  { id: "cmusc55690002dulk1u0ifs17", email: "lisi", name: "李四", role: "SALES" },
];

let 目录: string;
const 开着: PrismaClient[] = [];

async function 一台(名: string): Promise<PrismaClient> {
  const f = path.join(目录, `${名}.db`);
  fs.copyFileSync(测试库, f);
  const db = new PrismaClient({ datasourceUrl: `file:${f}` });
  开着.push(db);
  // 拷来的测试库里可能有别的用例留下的数据：清空业务表，种上模板账号
  for (const t of ["AiConversation", "AiProject", "Setting", "AuditLog", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead"]) {
    await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
  }
  await db.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
  const 那时 = new Date("2026-10-01T00:00:00Z");
  for (const u of 模板账号) await db.user.create({ data: { ...u, password: "x", title: "管理员", createdAt: 那时 } });
  return db;
}

/** 进团队：改身份 → 建表 → 装触发器 → 本机已有的整份记成新建 */
async function 进团队(db: PrismaClient, 账号: string, email: string, name: string) {
  await 改身份(db, `acct_${账号}`, { email, name });
  await 建同步表(db);
  await 装触发器(db);
  await 记全量(db);
}

const 钥匙 = 新钥匙();
/** 一台推：编号、加密成一包；对方拉：解密、回放。和真实循环一样经过 封 / 拆 */
async function 推(db: PrismaClient, 设备: string): Promise<string | null> {
  const { 改动: 批, 到 } = await 待推(db, 设备);
  if (!批.length) return null;
  await 记已推(db, 到);
  return 封(批, 钥匙);
}
async function 同步(甲: PrismaClient, 乙: PrismaClient) {
  const a = await 推(甲, "A");
  const b = await 推(乙, "B");
  if (a) await 回放(乙, 拆(a, 钥匙), "B");
  if (b) await 回放(甲, 拆(b, 钥匙), "A");
  // 回放不进日志；本机重算派生也不进：再推一轮应当都是空的
  return { a: a ? 拆(a, 钥匙).length : 0, b: b ? 拆(b, 钥匙).length : 0 };
}
const 睡 = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-sync-"));
});
afterEach(async () => {
  for (const db of 开着.splice(0)) await db.$disconnect();
  fs.rmSync(目录, { recursive: true, force: true });
});

describe("改身份（探针场景 ①）", () => {
  it("两台的管理员原本同一个 id；改成按云端账号算的，指向它的列（有外键、没外键的）都跟着改；没用过的占位账号删掉", async () => {
    const 甲 = await 一台("A");
    const c = await 甲.customer.create({ data: { name: "王总", phone: "13800000001", salesOwnerId: 模板账号[0].id } });
    await 甲.contractOwner.findMany(); // 表在
    await 甲.auditLog.create({ data: { userId: 模板账号[0].id, userName: "管理员", action: "create", entity: "Customer", entityId: c.id, summary: "x" } });
    await 改身份(甲, "acct_jia", { email: "jia@example.com", name: "甲" });
    expect((await 甲.user.findMany({ orderBy: { id: "asc" } })).map((u) => [u.id, u.email, u.name])).toEqual([["acct_jia", "jia@example.com", "甲"]]);
    expect((await 甲.customer.findUniqueOrThrow({ where: { id: c.id } })).salesOwnerId).toBe("acct_jia");
    expect((await 甲.auditLog.findFirstOrThrow()).userId).toBe("acct_jia");
    expect(await 甲.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("用过的占位账号不删，换成随机 id（它在每台电脑上也是同一个 id）", async () => {
    const 甲 = await 一台("A");
    await 甲.customer.create({ data: { name: "张三的客户", phone: "13800000002", salesOwnerId: 模板账号[1].id } });
    await 改身份(甲, "acct_jia", { email: "jia@example.com", name: "甲" });
    const 张三 = await 甲.user.findFirstOrThrow({ where: { name: "张三" } });
    expect(张三.id).not.toBe(模板账号[1].id);
    expect((await 甲.customer.findFirstOrThrow()).salesOwnerId).toBe(张三.id);
    expect(await 甲.user.count({ where: { name: "李四" } })).toBe(0);
  });
});

describe("推拉合并", () => {
  async function 一对() {
    const 甲 = await 一台("A");
    const 乙 = await 一台("B");
    await 进团队(甲, "jia", "jia@example.com", "甲");
    await 进团队(乙, "yi", "yi@example.com", "乙");
    await 同步(甲, 乙);
    return { 甲, 乙 };
  }

  it("进团队：两边的人互相过去（密码不同步，放占位）；装了触发器", async () => {
    const { 甲, 乙 } = await 一对();
    expect(await 装了吗(甲)).toBe(true);
    for (const db of [甲, 乙]) expect((await db.user.findMany({ orderBy: { id: "asc" } })).map((u) => u.id)).toEqual(["acct_jia", "acct_yi"]);
    expect((await 甲.user.findUniqueOrThrow({ where: { id: "acct_yi" } })).password).toBe("!team-sync");
    expect((await 甲.user.findUniqueOrThrow({ where: { id: "acct_jia" } })).password).toBe("x");
  });

  it("新建互相过去；回放不回声", async () => {
    const { 甲, 乙 } = await 一对();
    await 甲.customer.create({ data: { id: "c1", name: "王总", phone: "13800000001", salesOwnerId: "acct_jia" } });
    await 乙.customer.create({ data: { id: "c2", name: "李总", phone: "13800000002", salesOwnerId: "acct_yi" } });
    expect(await 同步(甲, 乙)).toEqual({ a: 1, b: 1 });
    expect(await 甲.customer.count()).toBe(2);
    expect(await 乙.customer.count()).toBe(2);
    expect(await 同步(甲, 乙)).toEqual({ a: 0, b: 0 });
  });

  it("改不同字段都留下；改同一字段后改的赢，和谁先同步无关", async () => {
    const { 甲, 乙 } = await 一对();
    await 甲.customer.create({ data: { id: "c1", name: "王总", phone: "13800000001", salesOwnerId: "acct_jia" } });
    await 同步(甲, 乙);
    await 甲.customer.update({ where: { id: "c1" }, data: { phone: "13900000001" } });
    await 乙.customer.update({ where: { id: "c1" }, data: { remark: "要样品" } });
    await 同步(甲, 乙);
    for (const db of [甲, 乙]) expect(await db.customer.findUniqueOrThrow({ where: { id: "c1" }, select: { phone: true, remark: true } })).toEqual({ phone: "13900000001", remark: "要样品" });

    await 甲.customer.update({ where: { id: "c1" }, data: { followStatus: "跟进中" } });
    await 睡(5);
    await 乙.customer.update({ where: { id: "c1" }, data: { followStatus: "意向较高" } });
    // 乙先推、甲后推：甲改得早，同步得晚也不该赢
    const b = await 推(乙, "B");
    await 回放(甲, 拆(b!, 钥匙), "A");
    const a = await 推(甲, "A");
    if (a) await 回放(乙, 拆(a, 钥匙), "B");
    for (const db of [甲, 乙]) expect((await db.customer.findUniqueOrThrow({ where: { id: "c1" } })).followStatus).toBe("意向较高");
  });

  it("我刚改、还没推，别人更早的改动拉过来不盖掉我的", async () => {
    const { 甲, 乙 } = await 一对();
    await 甲.customer.create({ data: { id: "c1", name: "王总", phone: "13800000001", salesOwnerId: "acct_jia" } });
    await 同步(甲, 乙);
    await 乙.customer.update({ where: { id: "c1" }, data: { remark: "乙早写的" } });
    await 睡(5);
    await 甲.customer.update({ where: { id: "c1" }, data: { remark: "甲晚写的" } });
    const b = await 推(乙, "B");
    await 回放(甲, 拆(b!, 钥匙), "A"); // 甲还没推
    expect((await 甲.customer.findUniqueOrThrow({ where: { id: "c1" } })).remark).toBe("甲晚写的");
    await 同步(甲, 乙);
    expect((await 乙.customer.findUniqueOrThrow({ where: { id: "c1" } })).remark).toBe("甲晚写的");
  });

  it("删除 vs 别人更晚的修改：带整行复活，两边一致；级联删的子表也同步", async () => {
    const { 甲, 乙 } = await 一对();
    await 甲.customer.create({ data: { id: "c2", name: "李总", phone: "13800000002", salesOwnerId: "acct_jia" } });
    await 甲.followUp.create({ data: { id: "f1", type: "PHONE", title: "", content: "x", status: "已完成", occurredAt: new Date(), customerId: "c2", ownerId: "acct_jia" } });
    await 同步(甲, 乙);
    await 甲.customer.delete({ where: { id: "c2" } });
    await 同步(甲, 乙);
    expect(await 乙.customer.count({ where: { id: "c2" } })).toBe(0);
    expect(await 乙.followUp.count({ where: { id: "f1" } })).toBe(0);
  });

  it("同名渠道撞唯一约束：两边都留 id 小的那个，引用改过去", async () => {
    const { 甲, 乙 } = await 一对();
    await 甲.channel.create({ data: { id: "chA", name: "小红书", channelOwnerId: "acct_jia" } });
    await 乙.channel.create({ data: { id: "chB", name: "小红书", channelOwnerId: "acct_yi" } });
    await 甲.customer.create({ data: { id: "c3", name: "甲的", phone: "13800000003", salesOwnerId: "acct_jia", channelId: "chA" } });
    await 乙.customer.create({ data: { id: "c4", name: "乙的", phone: "13800000004", salesOwnerId: "acct_yi", channelId: "chB" } });
    await 同步(甲, 乙);
    await 同步(甲, 乙);
    for (const db of [甲, 乙]) {
      expect((await db.channel.findMany()).map((c) => c.id)).toEqual(["chA"]);
      expect((await db.customer.findMany({ where: { id: { in: ["c3", "c4"] } }, orderBy: { id: "asc" } })).map((c) => c.channelId)).toEqual(["chA", "chA"]);
    }
  });

  it("最近跟进不同步、本机重算：取跟进记录里最晚那条，不是后补记的那条", async () => {
    const { 甲, 乙 } = await 一对();
    await 甲.customer.create({ data: { id: "c5", name: "赵总", phone: "13800000005", salesOwnerId: "acct_jia" } });
    await 同步(甲, 乙);
    const 晚 = new Date("2026-10-01T10:00:00Z"), 早 = new Date("2026-10-01T09:00:00Z");
    await 甲.followUp.create({ data: { type: "PHONE", title: "", content: "10 点", status: "已完成", occurredAt: 晚, customerId: "c5", ownerId: "acct_jia" } });
    await 甲.customer.update({ where: { id: "c5" }, data: { lastFollowAt: 晚 } });
    await 睡(5);
    await 乙.followUp.create({ data: { type: "PHONE", title: "", content: "9 点", status: "已完成", occurredAt: 早, customerId: "c5", ownerId: "acct_yi" } });
    await 乙.customer.update({ where: { id: "c5" }, data: { lastFollowAt: 早 } });
    await 同步(甲, 乙);
    for (const db of [甲, 乙]) expect((await db.customer.findUniqueOrThrow({ where: { id: "c5" } })).lastFollowAt?.toISOString()).toBe(晚.toISOString());
  });

  it("业务配置同步，AI Key 之类的本机设置不同步", async () => {
    const { 甲, 乙 } = await 一对();
    await 甲.setting.create({ data: { key: "business", value: JSON.stringify({ template: "trade" }) } });
    await 甲.setting.create({ data: { key: "llm.apiKey", value: JSON.stringify("sk-secret") } });
    await 同步(甲, 乙);
    expect((await 乙.setting.findMany()).map((s) => s.key)).toEqual(["business"]);
  });

  it("外贸那几张新表（报价、订单节点、比价）也同步；节点上一人改状态一人改日期都留下", async () => {
    const { 甲, 乙 } = await 一对();
    await 甲.customer.create({ data: { id: "c6", name: "Acme", phone: "13800000006", salesOwnerId: "acct_jia" } });
    await 甲.opportunity.create({ data: { id: "o1", name: "面板灯", amount: 7100, customerId: "c6", ownerId: "acct_jia" } });
    await 甲.quote.create({ data: { id: "q1", opportunityId: "o1", currency: "USD", lines: { create: [{ id: "l1", product: "LED", qty: 2000, unitPrice: 3.2 }] } } });
    await 甲.tradeOrder.create({ data: { id: "t1", no: "J-1", customerId: "c6", ownerId: "acct_jia", amount: 7100, nodes: { create: [{ id: "n5", idx: 5, name: "收定金" }] } } });
    await 甲.supplier.create({ data: { id: "s1", name: "明亮厂", quotes: { create: [{ opportunityId: "o1", product: "LED", unitPrice: 21.3 }] } } });
    await 同步(甲, 乙);
    await 乙.tradeOrderNode.update({ where: { id: "n5" }, data: { status: "已完成" } });
    await 甲.tradeOrderNode.update({ where: { id: "n5" }, data: { dueAt: new Date("2026-10-20T00:00:00Z") } });
    await 同步(甲, 乙);
    for (const db of [甲, 乙]) {
      expect(await db.quoteLine.count()).toBe(1);
      expect(await db.supplierQuote.count()).toBe(1);
      expect(await db.tradeOrderNode.findUniqueOrThrow({ where: { id: "n5" }, select: { status: true, dueAt: true } })).toEqual({ status: "已完成", dueAt: new Date("2026-10-20T00:00:00Z") });
    }
  });

  it("钥匙不对拆不开；密文里看不到客户名", async () => {
    const { 甲 } = await 一对();
    await 甲.customer.create({ data: { name: "看不见的王总", phone: "13800000009", salesOwnerId: "acct_jia" } });
    const a = (await 推(甲, "A"))!;
    expect(Buffer.from(a, "base64url").toString("latin1")).not.toContain("王总");
    expect(() => 拆(a, 新钥匙())).toThrow();
  });
});

describe("类型（编译期）", () => {
  it("改动的形状", () => {
    const x: 改动 = { t: "Customer", k: "c", o: "U", r: {}, c: ["name"], h: "000000000000001-A" };
    expect(x.o).toBe("U");
  });
});
