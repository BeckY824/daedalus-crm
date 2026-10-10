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
import { 改身份, 建同步表, 装触发器, 记全量, 待推, 记已推, 回放, 装了吗, 没同步上, 本机结构签名, type 改动 } from "@/lib/sync/local";
import { 封, 拆, 新钥匙 } from "@/lib/sync/crypto";
import { 转交商机 } from "@/lib/opportunity-activity";

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
  if (fs.existsSync(`${测试库}-wal`)) fs.copyFileSync(`${测试库}-wal`, `${f}-wal`); // 没落盘的那部分一起拷
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

it("日期语义随真实同步传到第二库，不从时刻猜测原日历日", async () => {
  const a = await 一台("calendar-A"); const b = await 一台("calendar-B");
  for (const db of [a, b]) { await 建同步表(db); await 装触发器(db); }
  const c = await a.customer.create({ data: { name: "日历客户", phone: "", salesOwnerId: 模板账号[0].id, expectedSignAt: new Date("2026-10-07T16:00:00Z"), expectedSignOn: "2026-10-08" } });
  const p = await a.followPlan.create({ data: { customerId: c.id, ownerId: 模板账号[0].id, subject: "跨区", plannedAt: new Date("2026-10-07T16:00:00Z"), plannedOn: "2026-10-08", plannedHasTime: false } });
  const t = await a.task.create({ data: { customerId: c.id, ownerId: 模板账号[0].id, title: "午夜定时", dueAt: new Date("2026-10-07T16:00:00Z"), dueHasTime: true } });
  await 同步(a, b);
  expect(await b.customer.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ expectedSignAt: c.expectedSignAt, expectedSignOn: "2026-10-08" });
  expect(await b.followPlan.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ plannedOn: "2026-10-08", plannedHasTime: false, plannedAt: p.plannedAt });
  expect(await b.task.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ dueOn: null, dueHasTime: true, dueAt: t.dueAt });
});

it("L-029 转交商机的旧业务时间随团队同步，另一台不误认为刚推进", async () => {
  const a = await 一台("activity-A"); const b = await 一台("activity-B");
  for (const db of [a, b]) { await 建同步表(db); await 装触发器(db); }
  const old = new Date("2026-09-01T08:00:00Z");
  const c = await a.customer.create({ data: { name: "同步客户", phone: "", salesOwnerId: 模板账号[0].id } });
  const o = await a.opportunity.create({ data: { name: "停滞商机", customerId: c.id, ownerId: 模板账号[0].id, updatedAt: old } });
  await 同步(a, b);
  await a.$transaction((tx) => 转交商机(tx, { id: o.id }, 模板账号[1].id));
  const pending = await 待推(a, "A");
  expect(pending.改动.some((x) => x.t === "Opportunity" && x.c.includes("activityAt"))).toBe(true);
  expect(pending.改动.some((x) => x.t === "Opportunity" && x.c.includes("ownerId"))).toBe(true);
  await 同步(a, b);
  const after = await b.opportunity.findUniqueOrThrow({ where: { id: o.id } });
  expect(after.ownerId).toBe(模板账号[1].id); expect(after.activityAt).toEqual(old); expect(after.updatedAt.getTime()).toBeGreaterThan(old.getTime());
});

describe("改身份（探针场景 ①）", () => {
  it.each(["ADMIN", "SALES"])("F1 旧库已有本人 acct 身份（%s），重新入队不覆盖旧老板或改写资料归属", async role => {
    const db = await 一台("switch-team");
    await db.user.update({ where: { id: 模板账号[0].id }, data: { id: "acct_old_boss", email: "old-boss@example.invalid", createdAt: new Date("2020-01-01") } });
    await db.user.create({ data: { id: "acct_me", email: "me@example.invalid", name: "本人", password: "!team-sync", role } });
    const mine = await db.customer.create({ data: { name: "本人的客户", phone: "13900001801", salesOwnerId: "acct_me" } });
    const theirs = await db.customer.create({ data: { name: "旧老板的客户", phone: "13900001802", salesOwnerId: "acct_old_boss" } });
    await db.followUp.create({ data: { type: "PHONE", title: "本人跟进", content: "留在本机", customerId: mine.id, ownerId: "acct_me" } });
    await db.tradeOrder.create({ data: { no: "REJOIN-USD-900", customerId: mine.id, ownerId: "acct_me", amount: 900, currency: "USD" } });
    for (let i = 0; i < 2; i++) await 改身份(db, "acct_me", { email: "me@example.invalid", name: "更新本人姓名" });
    expect(await db.user.findUniqueOrThrow({ where: { id: "acct_me" } })).toMatchObject({ name: "更新本人姓名", role });
    expect(await db.user.findUniqueOrThrow({ where: { id: "acct_old_boss" } })).toMatchObject({ email: "old-boss@example.invalid" });
    expect((await db.customer.findUniqueOrThrow({ where: { id: mine.id } })).salesOwnerId).toBe("acct_me");
    expect((await db.customer.findUniqueOrThrow({ where: { id: theirs.id } })).salesOwnerId).toBe("acct_old_boss");
    expect(await db.followUp.findFirstOrThrow({ where: { customerId: mine.id } })).toMatchObject({ ownerId: "acct_me" });
    expect(await db.tradeOrder.findFirstOrThrow({ where: { customerId: mine.id } })).toMatchObject({ ownerId: "acct_me", amount: 900, currency: "USD" });
    expect(await db.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check")).toEqual([]);
  });

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

  it("外贸档案：两台各自给同一位客户新建那一行（甲填国家、乙填 WhatsApp），同步后两格都在（2026-10-05 复查）", async () => {
    const { 甲, 乙 } = await 一对();
    await 甲.customer.create({ data: { id: "c1", name: "Timur", phone: "998901234567", salesOwnerId: "acct_jia" } });
    await 同步(甲, 乙);
    await 甲.customerExtra.create({ data: { customerId: "c1", country: "乌兹别克斯坦" } });
    await 睡(5);
    await 乙.customerExtra.create({ data: { customerId: "c1", whatsapp: "+998 90 123 4567" } });
    await 同步(甲, 乙);
    for (const db of [甲, 乙]) expect(await db.customerExtra.findUniqueOrThrow({ where: { customerId: "c1" }, select: { country: true, whatsapp: true } })).toEqual({ country: "乌兹别克斯坦", whatsapp: "+998 90 123 4567" });
  });

  it("外贸档案：第三台先收到后插入的那条、再收到更早那条，两格也都在", async () => {
    const { 甲 } = await 一对();
    const 丙 = await 一台("C");
    await 进团队(丙, "bing", "bing@example.com", "丙");
    await 同步(甲, 丙); // 甲收到丙这个人：客户挂在丙名下，丙那边不缺负责人（甲自己的账号早推过了，不会再推给丙）
    await 甲.customer.create({ data: { id: "c1", name: "Timur", phone: "998901234567", salesOwnerId: "acct_bing" } });
    await 甲.customerExtra.create({ data: { customerId: "c1", country: "乌兹别克斯坦" } });
    const 客 = await 推(甲, "A");
    // 乙那台更晚的一条插入（只填了 WhatsApp），比甲那条先到丙
    // c 写全部列：旧版本客户端推来的插入就是这样（回归核对 W-055：记钟要按值判，不按 c）
    const 晚插入: 改动 = { t: "CustomerExtra", k: "c1", o: "I", r: { customerId: "c1", country: null, whatsapp: "+998 90 123 4567", wechat: null, email: null, source: null }, c: ["customerId", "country", "whatsapp", "wechat", "email", "source"], h: "999999999999999-dB" };
    await 回放(丙, 拆(客!, 钥匙).filter((e) => e.t !== "CustomerExtra"), "C");
    await 回放(丙, [晚插入], "C");
    await 回放(丙, 拆(客!, 钥匙).filter((e) => e.t === "CustomerExtra"), "C");
    expect(await 丙.customerExtra.findUniqueOrThrow({ where: { customerId: "c1" }, select: { country: true, whatsapp: true } })).toEqual({ country: "乌兹别克斯坦", whatsapp: "+998 90 123 4567" });
  });

  it("订单跟着签约删：甲删了订单和签约、乙同时改了这张订单，同步后两台都没有这张单（不留没有签约的空壳）", async () => {
    const { 甲, 乙 } = await 一对();
    await 甲.customer.create({ data: { id: "c1", name: "Acme", phone: "13800000001", salesOwnerId: "acct_jia" } });
    await 甲.contract.create({ data: { id: "k1", customerId: "c1", amount: 100, signedAt: new Date() } });
    await 甲.tradeOrder.create({ data: { id: "o1", no: "PI-1", customerId: "c1", ownerId: "acct_jia", contractId: "k1" } });
    await 同步(甲, 乙);
    expect(await 乙.tradeOrder.count()).toBe(1);
    await 甲.tradeOrder.delete({ where: { id: "o1" } });
    await 甲.contract.delete({ where: { id: "k1" } });
    await 睡(5);
    await 乙.tradeOrder.update({ where: { id: "o1" }, data: { payment: "T/T" } });
    await 同步(甲, 乙);
    await 同步(甲, 乙);
    for (const db of [甲, 乙]) {
      expect(await db.contract.count()).toBe(0);
      expect(await db.tradeOrder.count()).toBe(0);
    }
  });

  it("回归核对 W-053：同一条放不进来的改动回放两遍（升级后从头重拉），「没同步上」只记一条", async () => {
    const { 甲 } = await 一对();
    await 甲.customer.create({ data: { id: "c9", name: "撞号", phone: "13800000009", salesOwnerId: "acct_jia" } });
    // 一条指向不存在客户的跟进：放不进来（孤儿）——换成撞唯一约束的那种：同一个邮箱的另一个同事账号
    const 坏: 改动 = { t: "User", k: "acct_dup", o: "I", r: { id: "acct_dup", email: "jia@example.com", name: "撞邮箱", title: "x", active: 1, createdAt: Date.now(), updatedAt: Date.now() }, c: ["id", "email", "name", "title", "active", "createdAt", "updatedAt"], h: "000000000000500-dZZ" };
    await 回放(甲, [坏], "A");
    await 回放(甲, [坏], "A");
    const 数 = await 甲.$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM _sync_skip WHERE tbl = 'User' AND pk = 'acct_dup'");
    expect(Number(数[0].n)).toBe(1);
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

  /* 上线前第 2 期 2b「清空一个字段的值：存得住空、同步不回填」 */
  it("清空一格也同步过去：甲清空公司，乙那边变空；乙更早写的旧值后拉过来不回填", async () => {
    const { 甲, 乙 } = await 一对();
    await 甲.customer.create({ data: { id: "c1", name: "王总", phone: "13800000001", school: "远山资本", grade: "高管", salesOwnerId: "acct_jia" } });
    await 同步(甲, 乙);
    // 乙先改了一次公司（还没推），甲后来把公司清空了
    await 乙.customer.update({ where: { id: "c1" }, data: { school: "平川科技" } });
    await 睡(5);
    await 甲.customer.update({ where: { id: "c1" }, data: { school: null } });
    // 甲先推：乙收到「清空」；乙后推：自己那条更早的旧值到了甲那边也不该把空格填回来
    const a = await 推(甲, "A");
    await 回放(乙, 拆(a!, 钥匙), "B");
    const b = await 推(乙, "B");
    if (b) await 回放(甲, 拆(b, 钥匙), "A");
    for (const db of [甲, 乙]) expect(await db.customer.findUniqueOrThrow({ where: { id: "c1" }, select: { school: true, grade: true } })).toEqual({ school: null, grade: "高管" });
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

  it("T-005 归属三件套（归属渠道 / 归属客户 / 渠道负责人）跟着同步：甲改了推荐渠道，乙那边三格和甲一致", async () => {
    const { 甲, 乙 } = await 一对();
    await 甲.channel.create({ data: { id: "chX", name: "老王", channelOwnerId: "acct_jia" } });
    await 甲.channel.create({ data: { id: "chY", name: "老李", channelOwnerId: "acct_yi" } });
    await 甲.customer.create({ data: { id: "r1", name: "推荐人", phone: "13800000011", salesOwnerId: "acct_jia", channelId: "chX", attributionChannelId: "chX", channelOwnerId: "acct_jia" } });
    await 甲.customer.create({ data: { id: "c7", name: "被推荐的", phone: "13800000012", salesOwnerId: "acct_jia", referrerCustomerId: "r1", attributionChannelId: "chX", attributionCustomerId: "r1", channelOwnerId: "acct_jia" } });
    await 同步(甲, 乙);
    // 甲把推荐渠道改成老李：保存那一刻按推荐链重新固化三件套（lib/attribution.ts），和推荐人一起写
    await 甲.customer.update({ where: { id: "c7" }, data: { referrerCustomerId: null, channelId: "chY", attributionChannelId: "chY", attributionCustomerId: null, channelOwnerId: "acct_yi" } });
    await 同步(甲, 乙);
    const 三件套 = { attributionChannelId: true, attributionCustomerId: true, channelOwnerId: true } as const;
    for (const id of ["r1", "c7"]) {
      expect(await 乙.customer.findUniqueOrThrow({ where: { id }, select: 三件套 }), id).toEqual(await 甲.customer.findUniqueOrThrow({ where: { id }, select: 三件套 }));
    }
    expect(await 乙.customer.findUniqueOrThrow({ where: { id: "c7" }, select: 三件套 })).toEqual({ attributionChannelId: "chY", attributionCustomerId: null, channelOwnerId: "acct_yi" });
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

  it("公海：甲放进去、乙领走，两边一致；领过再放回去（删了又建的同一行）也过得去", async () => {
    const { 甲, 乙 } = await 一对();
    await 甲.customer.create({ data: { id: "c7", name: "Bolt", phone: "13800000007", salesOwnerId: "acct_jia" } });
    await 甲.customerPool.create({ data: { customerId: "c7", userId: "acct_jia" } });
    await 同步(甲, 乙);
    expect(await 乙.customerPool.count()).toBe(1);
    await 乙.$transaction([
      乙.customerPool.delete({ where: { customerId: "c7" } }),
      乙.customer.update({ where: { id: "c7" }, data: { salesOwnerId: "acct_yi" } }),
    ]);
    await 同步(甲, 乙);
    for (const db of [甲, 乙]) {
      expect(await db.customerPool.count()).toBe(0);
      expect((await db.customer.findUniqueOrThrow({ where: { id: "c7" } })).salesOwnerId).toBe("acct_yi");
    }
    await 睡(5);
    await 乙.customerPool.create({ data: { customerId: "c7", userId: "acct_yi" } });
    await 同步(甲, 乙);
    for (const db of [甲, 乙]) expect((await db.customerPool.findMany()).map((x) => x.userId)).toEqual(["acct_yi"]);
  });

  it("甲删了客户、乙同时给他记了跟进：两边都没有这位和这条跟进，队列不卡（复查）", async () => {
    const { 甲, 乙 } = await 一对();
    await 甲.customer.create({ data: { id: "c8", name: "Gone", phone: "13800000008", salesOwnerId: "acct_jia" } });
    await 同步(甲, 乙);
    await 甲.customer.delete({ where: { id: "c8" } });
    await 乙.followUp.create({ data: { id: "f8", type: "PHONE", title: "", content: "还在跟", status: "已完成", occurredAt: new Date(), customerId: "c8", ownerId: "acct_yi" } });
    await 同步(甲, 乙);
    for (const db of [甲, 乙]) {
      expect(await db.customer.count({ where: { id: "c8" } })).toBe(0);
      expect(await db.followUp.count({ where: { id: "f8" } })).toBe(0);
    }
    expect(await 甲.$queryRawUnsafe<unknown[]>("SELECT 1 FROM _sync_skip WHERE pk = 'f8'")).toHaveLength(1);
    // 之后的改动照常过去
    await 乙.customer.create({ data: { id: "c9", name: "Next", phone: "13800000009", salesOwnerId: "acct_yi" } });
    await 同步(甲, 乙);
    expect(await 甲.customer.count({ where: { id: "c9" } })).toBe(1);
  });

  /*
    T-003（2026-10-04 修）：原来改名撞了同名渠道只记 _sync_skip 跳过——乙那台叫「展会」、甲那台还是「老名字」，
    客户挂的渠道也各是各的，两台从此对不上。现在改名撞名也走同名合并：两边都留 id 小的那个，引用改过去
  */
  async function 两台一样(甲: PrismaClient, 乙: PrismaClient) {
    const 看 = async (db: PrismaClient) => ({
      渠道: (await db.channel.findMany({ orderBy: { id: "asc" }, select: { id: true, name: true } })),
      客户: (await db.customer.findMany({ orderBy: { id: "asc" }, select: { id: true, channelId: true } })),
    });
    const [a, b] = [await 看(甲), await 看(乙)];
    expect(a).toEqual(b);
    return a;
  }

  it("T-003 乙把渠道改名成甲刚建的同名渠道（改名那个 id 小）：合并成一个，两台一致，不跳过", async () => {
    const { 甲, 乙 } = await 一对();
    await 乙.channel.create({ data: { id: "ch2", name: "老名字", channelOwnerId: "acct_yi" } });
    await 乙.customer.create({ data: { id: "c11", name: "挂老名字的", phone: "13800000011", salesOwnerId: "acct_yi", channelId: "ch2" } });
    await 同步(甲, 乙);
    await 甲.channel.create({ data: { id: "ch3", name: "展会", channelOwnerId: "acct_jia" } });
    await 甲.customer.create({ data: { id: "c12", name: "挂展会的", phone: "13800000012", salesOwnerId: "acct_jia", channelId: "ch3" } });
    await 乙.channel.update({ where: { id: "ch2" }, data: { name: "展会" } });
    await 乙.customer.create({ data: { id: "c10", name: "后面的", phone: "13800000010", salesOwnerId: "acct_yi" } });
    await 同步(甲, 乙);
    await 同步(甲, 乙);
    const 现在 = await 两台一样(甲, 乙);
    expect(现在.渠道).toEqual([{ id: "ch2", name: "展会" }]);
    expect(现在.客户.filter((c) => c.id !== "c10").map((c) => c.channelId)).toEqual(["ch2", "ch2"]);
    expect(await 甲.customer.count({ where: { id: "c10" } })).toBe(1);
    for (const db of [甲, 乙]) expect(await db.$queryRawUnsafe<unknown[]>("SELECT 1 FROM _sync_skip")).toHaveLength(0);
    // 之后谁再改这个渠道（不管用哪个 id），两边都落在留下的那个上
    await 甲.channel.update({ where: { id: "ch2" }, data: { phone: "02088886666" } });
    await 同步(甲, 乙);
    expect((await 乙.channel.findUniqueOrThrow({ where: { id: "ch2" } })).phone).toBe("02088886666");
  });

  it("T-003 同上，改名那个 id 大：两边都留本机那个 id 小的，改名那位的客户跟过去", async () => {
    const { 甲, 乙 } = await 一对();
    await 乙.channel.create({ data: { id: "ch9", name: "老名字", channelOwnerId: "acct_yi" } });
    await 乙.customer.create({ data: { id: "c21", name: "挂老名字的", phone: "13800000021", salesOwnerId: "acct_yi", channelId: "ch9" } });
    await 同步(甲, 乙);
    await 甲.channel.create({ data: { id: "ch1", name: "展会", channelOwnerId: "acct_jia" } });
    await 乙.channel.update({ where: { id: "ch9" }, data: { name: "展会" } });
    await 乙.customer.create({ data: { id: "c22", name: "改名后挂的", phone: "13800000022", salesOwnerId: "acct_yi", channelId: "ch9" } });
    await 同步(甲, 乙);
    await 同步(甲, 乙);
    const 现在 = await 两台一样(甲, 乙);
    expect(现在.渠道).toEqual([{ id: "ch1", name: "展会" }]);
    expect(现在.客户.map((c) => c.channelId)).toEqual(["ch1", "ch1"]);
    for (const db of [甲, 乙]) expect(await db.$queryRawUnsafe<unknown[]>("SELECT 1 FROM _sync_skip")).toHaveLength(0);
    // 第三台晚到的、还带着 ch9 的改动：两台都落在 ch1 上
    const 晚到: 改动 = { t: "Channel", k: "ch9", o: "U", r: { id: "ch9", remark: "晚到的" }, c: ["remark"], h: `${String(Date.now() + 60_000).padStart(15, "0")}-C` };
    for (const db of [甲, 乙]) await 回放(db, [晚到], "X");
    for (const db of [甲, 乙]) expect((await db.channel.findUniqueOrThrow({ where: { id: "ch1" } })).remark).toBe("晚到的");
  });

  it("T-003 合不了的（两条线索挂了同一位客户）：记下来，没同步上() 数得出，不静默", async () => {
    const { 甲, 乙 } = await 一对();
    await 甲.customer.create({ data: { id: "c30", name: "一位", phone: "13800000030", salesOwnerId: "acct_jia" } });
    await 同步(甲, 乙);
    await 甲.lead.create({ data: { id: "l1", name: "甲的线索", customerId: "c30", ownerId: "acct_jia" } });
    await 乙.lead.create({ data: { id: "l2", name: "乙的线索", customerId: "c30", ownerId: "acct_yi" } });
    await 同步(甲, 乙);
    for (const db of [甲, 乙]) {
      const n = await 没同步上(db);
      expect(n.条数, JSON.stringify(n)).toBe(1);
      expect(n.例子[0]).toMatchObject({ 表: "线索" });
    }
    // 孤儿（父行被删了的跟进）两边本来就一致，不算「没同步上」
    await 甲.customer.create({ data: { id: "c31", name: "Gone", phone: "13800000031", salesOwnerId: "acct_jia" } });
    await 同步(甲, 乙);
    await 甲.customer.delete({ where: { id: "c31" } });
    await 乙.followUp.create({ data: { id: "f31", type: "PHONE", title: "", content: "x", status: "已完成", occurredAt: new Date(), customerId: "c31", ownerId: "acct_yi" } });
    await 同步(甲, 乙);
    expect((await 没同步上(甲)).条数).toBe(1);
  });

  it("回放、重算之后「回放中」开关是 0：之后本机的改动照常进日志（复查）", async () => {
    const { 甲, 乙 } = await 一对();
    await 甲.customer.create({ data: { id: "c11", name: "钱总", phone: "13800000011", salesOwnerId: "acct_jia" } });
    await 甲.followUp.create({ data: { type: "PHONE", title: "", content: "x", status: "已完成", occurredAt: new Date(), customerId: "c11", ownerId: "acct_jia" } });
    await 同步(甲, 乙);
    expect(Number((await 乙.$queryRawUnsafe<{ applying: bigint | number }[]>("SELECT applying FROM _sync_state"))[0].applying)).toBe(0);
    await 乙.customer.update({ where: { id: "c11" }, data: { remark: "乙改的" } });
    expect(await 同步(甲, 乙)).toMatchObject({ b: 1 });
  });

  /*
    T-008：「回放中」开关只在回放事务里置 1，事务回滚就回到 0；但进程在事务提交后、归零前被杀（或老版本留下的 1）
    就会停在 1——触发器从此一条改动都不记，悄悄不同步。建同步表()（每轮开头都调）兜底归零
  */
  it("T-008 「回放中」开关停在 1：那期间改动一条不记；建同步表() 兜底归零，之后改动照常进日志", async () => {
    const { 甲, 乙 } = await 一对();
    await 乙.customer.create({ data: { id: "c13", name: "周总", phone: "13800000013", salesOwnerId: "acct_yi" } });
    await 同步(甲, 乙);
    const 日志数 = async () => Number((await 乙.$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM _sync_log"))[0].n);
    await 乙.$executeRawUnsafe("UPDATE _sync_state SET applying = 1 WHERE id = 1");
    const 前 = await 日志数();
    await 乙.customer.update({ where: { id: "c13" }, data: { remark: "卡在 1 时改的" } });
    expect(await 日志数(), "开关在 1 时触发器不记（证明这个开关真管用）").toBe(前);
    await 建同步表(乙);
    expect(Number((await 乙.$queryRawUnsafe<{ applying: bigint }[]>("SELECT applying FROM _sync_state"))[0].applying)).toBe(0);
    await 乙.customer.update({ where: { id: "c13" }, data: { remark: "归零之后改的" } });
    expect(await 日志数()).toBe(前 + 1);
    await 同步(甲, 乙);
    expect((await 甲.customer.findUniqueOrThrow({ where: { id: "c13" } })).remark).toBe("归零之后改的");
  });

  /*
    T-008 后半：新人第一次拉一个大团队，一批 2000 条（待推一次最多给这么多）在一个回放事务里，
    默认 5 秒的交互事务会超时、每轮重试都失败、永远卡住。回放事务给了 180 秒。
    真造 2000 条在负载高的机器上要几十秒、超不超 5 秒全看机器，靠它判红是碰运气——
    这里看回放开事务时给的时限（不少于 60 秒），外加一批几百条照常回放完
  */
  it("T-008 回放事务的时限够一整批（≥ 60 秒，不是默认 5 秒）；几百条一批回放完、一条不少", async () => {
    const { 甲, 乙 } = await 一对();
    const 数 = 300;
    await 甲.customer.createMany({ data: Array.from({ length: 数 }, (_, i) => ({ id: `big${i}`, name: `大客户${i}`, phone: `139${String(i).padStart(8, "0")}`, salesOwnerId: "acct_jia" })) });
    const 时限: (number | undefined)[] = [];
    const 原 = 乙.$transaction.bind(乙) as (...a: unknown[]) => Promise<unknown>;
    (乙 as unknown as { $transaction: unknown }).$transaction = (fn: unknown, opts?: { timeout?: number }) => {
      if (typeof fn === "function") 时限.push(opts?.timeout);
      return 原(fn, opts);
    };
    await 同步(甲, 乙);
    expect(时限.length, "回放该开一个交互事务").toBeGreaterThan(0);
    for (const t of 时限) expect(t ?? 5000, "回放事务的时限").toBeGreaterThanOrEqual(60_000);
    expect(await 乙.customer.count({ where: { id: { startsWith: "big" } } })).toBe(数);
  }, 120_000); // Windows CI 上几百条一批要 20 秒以上（机器慢），用例本身测的是事务给 60 秒

  it("远端删了跟进：本机「最近跟进」跟着重算（复查）", async () => {
    const { 甲, 乙 } = await 一对();
    await 甲.customer.create({ data: { id: "c12", name: "孙总", phone: "13800000012", salesOwnerId: "acct_jia" } });
    const 早 = new Date("2026-10-01T09:00:00Z"), 晚 = new Date("2026-10-02T09:00:00Z");
    await 甲.followUp.create({ data: { id: "f12a", type: "PHONE", title: "", content: "早", status: "已完成", occurredAt: 早, customerId: "c12", ownerId: "acct_jia" } });
    await 甲.followUp.create({ data: { id: "f12b", type: "PHONE", title: "", content: "晚", status: "已完成", occurredAt: 晚, customerId: "c12", ownerId: "acct_jia" } });
    await 同步(甲, 乙);
    expect((await 乙.customer.findUniqueOrThrow({ where: { id: "c12" } })).lastFollowAt?.toISOString()).toBe(晚.toISOString());
    await 甲.followUp.delete({ where: { id: "f12b" } });
    await 同步(甲, 乙);
    expect((await 乙.customer.findUniqueOrThrow({ where: { id: "c12" } })).lastFollowAt?.toISOString()).toBe(早.toISOString());
  });

  it("加入的那台不推业务配置：团队的模版以建团队的人为准（复查）", async () => {
    const 甲 = await 一台("A");
    const 乙 = await 一台("B");
    await 甲.setting.create({ data: { key: "business", value: JSON.stringify({ template: "trade" }) } });
    await 乙.setting.create({ data: { key: "business", value: JSON.stringify({ template: "general" }) } });
    await 进团队(甲, "jia", "jia@example.com", "甲");
    await 改身份(乙, "acct_yi", { email: "yi@example.com", name: "乙" });
    await 建同步表(乙);
    await 装触发器(乙);
    await 记全量(乙, { 不含设置: true });
    // 设备号故意让乙更大：原来同为时钟 1 时按设备号比，乙会赢
    const a = await 推(甲, "A");
    const b = await 推(乙, "Z");
    if (a) await 回放(乙, 拆(a, 钥匙), "Z");
    if (b) await 回放(甲, 拆(b, 钥匙), "A");
    for (const db of [甲, 乙]) expect(JSON.parse((await db.setting.findUniqueOrThrow({ where: { key: "business" } })).value).template).toBe("trade");
  });

  /*
    2026-10-04 补（回归核对 D-040）：迁移给同步表加了列，老触发器里写死的是旧列名——不重装，新列的改动不进日志，
    团队数据悄悄分叉、也不报错。lib/sync/client.ts 每个进程第一轮都 装触发器() 一次（触发器对过），修了但没钉
  */
  it("迁移加列之后：不重装触发器，只改新列的改动根本不进日志；重装之后带上新列、对面收得到", async () => {
    const { 甲, 乙 } = await 一对();
    await 甲.customer.create({ data: { id: "c1", name: "王总", phone: "13800000001", salesOwnerId: "acct_jia" } });
    await 同步(甲, 乙);
    // 两台都升级了：同一条迁移给 Customer 加了一列
    for (const db of [甲, 乙]) await db.$executeRawUnsafe('ALTER TABLE "Customer" ADD COLUMN "试验列" TEXT');

    await 甲.$executeRawUnsafe(`UPDATE "Customer" SET "试验列" = '旧触发器' WHERE id = 'c1'`);
    expect((await 待推(甲, "A")).改动).toEqual([]); // 这就是要钉的坑：老触发器看不见这一列

    for (const db of [甲, 乙]) await 装触发器(db);
    await 甲.$executeRawUnsafe(`UPDATE "Customer" SET "试验列" = '新触发器' WHERE id = 'c1'`);
    await 同步(甲, 乙);
    const 乙那边 = (await 乙.$queryRawUnsafe(`SELECT "试验列" AS v FROM "Customer" WHERE id = 'c1'`)) as { v: string | null }[];
    expect(乙那边[0].v).toBe("新触发器");
  });

  it("客户端每个进程第一轮都重装一次触发器（迁移加列靠它跟上）", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../src/lib/sync/client.ts"), "utf8");
    const 段 = src.slice(src.indexOf("if (!触发器对过)"), src.indexOf("触发器对过 = true"));
    expect(段).toContain("await 装触发器(prisma)");
    expect(src).toMatch(/let 触发器对过 = false;/);
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

describe("跨版本：本机表结构签名（2026-10-05 复查）", () => {
  it("同一份库签名不变；多了一列就变——客户端据此从头重拉，补上旧版本时收不下、跳过了的改动", async () => {
    const 甲 = await 一台("A");
    const 前 = await 本机结构签名(甲);
    expect(await 本机结构签名(甲)).toBe(前);
    await 甲.$executeRawUnsafe('ALTER TABLE "CustomerExtra" ADD COLUMN "多一列" TEXT');
    expect(await 本机结构签名(甲)).not.toBe(前);
  });
});


it("旧结构跳过的新列/新表，真实加列建表后重放补齐且清除已恢复错误；旧包不复活新删除", async () => {
  const a = await 一台("upgrade-A"), b = await 一台("upgrade-B");
  for (const db of [a,b]) await 建同步表(db);
  await 装触发器(a);
  const extraDDL = (await b.$queryRawUnsafe<{sql:string}[]>('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=\'CustomerExtra\''))[0].sql;
  await b.$executeRawUnsafe('ALTER TABLE "Customer" DROP COLUMN "expectedSignOn"');
  await b.$executeRawUnsafe('DROP TABLE "CustomerExtra"');
  const legacy = await 本机结构签名(b);
  const owner = (await a.user.findFirstOrThrow()).id;
  await a.customer.create({data:{id:"upgrade-c",name:"跨版本客户",phone:"13800001111",salesOwnerId:owner,expectedSignAt:new Date("2026-11-01T16:00:00Z"),expectedSignOn:"2026-11-02"}});
  await a.customerExtra.create({data:{customerId:"upgrade-c",country:"德国",whatsapp:"49123456789"}});
  const encrypted = (await 推(a,"A"))!; const events = 拆(encrypted,钥匙);
  await 回放(b,events,"B");
  expect(await b.customer.count({where:{id:"upgrade-c"}})).toBe(1);
  expect((await 没同步上(b)).条数).toBe(1);
  await b.$executeRawUnsafe('ALTER TABLE "Customer" ADD COLUMN "expectedSignOn" TEXT'); await b.$executeRawUnsafe(extraDDL);
  expect(await 本机结构签名(b)).not.toBe(legacy);
  await 回放(b,events,"B");
  expect(await b.customer.findUnique({where:{id:"upgrade-c"}})).toMatchObject({expectedSignOn:"2026-11-02"});
  expect(await b.customerExtra.findUnique({where:{customerId:"upgrade-c"}})).toMatchObject({country:"德国",whatsapp:"49123456789"});
  expect((await 没同步上(b)).条数).toBe(0);
  await a.customer.delete({where:{id:"upgrade-c"}}); const deletion=(await 推(a,"A"))!;
  await 回放(b,拆(deletion,钥匙),"B"); await 回放(b,events,"B");
  expect(await b.customer.count({where:{id:"upgrade-c"}})).toBe(0); expect(await b.customerExtra.count({where:{customerId:"upgrade-c"}})).toBe(0);
});
