/**
 * 换负责人、停用同事，历史业绩不搬家（2026-10-02 排查 B2）。
 *
 * 原来数据页按客户「现在」的负责人汇总签约：张三去年签了 50 万，客户转给李四以后，
 * 去年的业绩榜上这 50 万就成了李四的；停用张三更是整批搬走。这和 09 月拍板
 * 「谁的数据没动，谁的归属就不变」矛盾。现在签约那一刻记下是谁的单（ContractOwner）。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "管理员", email: "admin", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { saveContract, assignSalesOwner, patchCustomer } from "@/app/(app)/customers/actions";
import { deactivateUser } from "@/app/(app)/settings/actions";
import { 加载复盘, 按人明细 } from "@/app/(app)/overview/data";
import { runQuery } from "@/lib/report-run";
import { DEFAULT_BUSINESS } from "@/lib/business-config";

let 张三: { id: string };
let 李四: { id: string };
let 渠道: { id: string };
let 客户: { id: string };

const 今年 = { from: new Date("2026-01-01"), to: new Date("2027-01-01") };
const 业绩 = async () => {
  const r = await 加载复盘(今年.from, 今年.to, "month");
  return Object.fromEntries(r.bySales.map((x) => [x.id, x.amount]));
};
const 渠道业绩 = async () => {
  const r = await 加载复盘(今年.from, 今年.to, "month");
  return Object.fromEntries(r.byChannelOwner.map((x) => [x.id, x.amount]));
};

beforeEach(async () => {
  await resetDb();
  const admin = await prisma.user.create({ data: { email: "admin", name: "管理员", title: "管理员", role: "ADMIN", password: "x" } });
  mocks.user.id = admin.id;
  张三 = await prisma.user.create({ data: { email: "zs", name: "张三", title: "销售", role: "SALES", password: "x" } });
  李四 = await prisma.user.create({ data: { email: "ls", name: "李四", title: "销售", role: "SALES", password: "x" } });
  渠道 = await prisma.channel.create({ data: { name: "小红", channelOwnerId: 张三.id } });
  客户 = await prisma.customer.create({
    data: { name: "王同学", phone: "13800000001", salesOwnerId: 张三.id, channelId: 渠道.id, channelOwnerId: 张三.id },
  });
  const r = await saveContract({ customerId: 客户.id, amount: 500000, signedAt: new Date("2026-03-01"), remark: null });
  if (!r.ok) throw new Error("签约没登记上");
});

afterAll(async () => { await prisma.$disconnect(); });

describe("B2 业绩算在签约那一刻的人头上", () => {
  it("登记签约时记下当时的销售负责人和渠道负责人", async () => {
    const c = await prisma.contract.findFirstOrThrow({ include: { owner: true } });
    expect(c.owner).toMatchObject({ salesOwnerId: 张三.id, channelOwnerId: 张三.id });
  });

  it("客户转给李四：之后的业绩榜上，那 50 万还是张三的", async () => {
    await assignSalesOwner([客户.id], 李四.id);
    expect(await 业绩()).toEqual({ [张三.id]: 500000 });
    // AI 的「按销售看签约」和数据页同一个口径
    const rows = await runQuery({ metric: "contract_amount", groupBy: "sales", from: null, to: null }, DEFAULT_BUSINESS);
    expect(rows.map((r) => [r.label, r.value])).toEqual([["张三", 500000]]);
  });

  it("停用张三、转给李四：往后要跟的活转走，历史不动", async () => {
    const 赢单 = await prisma.opportunity.create({ data: { customerId: 客户.id, ownerId: 张三.id, name: "老单", amount: 1, stage: "赢单成交", status: "WON" } });
    const 在谈 = await prisma.opportunity.create({ data: { customerId: 客户.id, ownerId: 张三.id, name: "新单", amount: 1, stage: "初步接洽" } });
    const 做完的 = await prisma.task.create({ data: { customerId: 客户.id, ownerId: 张三.id, title: "做完了", done: true } });
    const 没做的 = await prisma.task.create({ data: { customerId: 客户.id, ownerId: 张三.id, title: "还没做" } });

    expect(await deactivateUser(张三.id, 李四.id)).toMatchObject({ ok: true });

    const c = await prisma.customer.findUniqueOrThrow({ where: { id: 客户.id } });
    expect(c.salesOwnerId).toBe(李四.id); // 往后由李四跟
    expect(c.channelOwnerId).toBe(张三.id); // 他带来的人，归属不改写
    expect((await prisma.channel.findUniqueOrThrow({ where: { id: 渠道.id } })).channelOwnerId).toBe(李四.id); // 渠道以后新来的归李四
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: 赢单.id } })).ownerId).toBe(张三.id);
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: 在谈.id } })).ownerId).toBe(李四.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: 做完的.id } })).ownerId).toBe(张三.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: 没做的.id } })).ownerId).toBe(李四.id);

    expect(await 业绩()).toEqual({ [张三.id]: 500000 });
    expect(await 渠道业绩()).toEqual({ [张三.id]: 500000 });

    // 留痕里记下转走了哪些，要手工退回有据可依
    const 痕 = await prisma.auditLog.findFirstOrThrow({ where: { action: "deactivate" } });
    expect(痕.detail).toContain(客户.id);
    expect(痕.detail).toContain(在谈.id);
    expect(痕.detail).not.toContain(赢单.id);
  });

  it("老签约（0.46.15 之前登记的，没有那一行）：退回按客户现在的负责人算", async () => {
    await prisma.contractOwner.deleteMany();
    await prisma.customer.update({ where: { id: 客户.id }, data: { salesOwnerId: 李四.id } });
    expect(await 业绩()).toEqual({ [李四.id]: 500000 });
  });
});

describe("B3 换客户负责人，原负责人没做完的活跟着走", () => {
  async function 摆活() {
    const 王五 = await prisma.user.create({ data: { email: "ww", name: "王五", title: "销售", role: "SALES", password: "x" } });
    const 计划 = await prisma.followPlan.create({ data: { customerId: 客户.id, ownerId: 张三.id, subject: "回访", plannedAt: new Date() } });
    const 待办 = await prisma.task.create({ data: { customerId: 客户.id, ownerId: 张三.id, title: "寄资料" } });
    const 做完的 = await prisma.task.create({ data: { customerId: 客户.id, ownerId: 张三.id, title: "已寄", done: true } });
    const 别人的 = await prisma.task.create({ data: { customerId: 客户.id, ownerId: 王五.id, title: "王五自己的" } });
    const 在谈 = await prisma.opportunity.create({ data: { customerId: 客户.id, ownerId: 张三.id, name: "续费", amount: 1, stage: "初步接洽" } });
    const 赢单 = await prisma.opportunity.create({ data: { customerId: 客户.id, ownerId: 张三.id, name: "首单", amount: 1, stage: "赢单成交", status: "WON" } });
    const 主 = async (m: "followPlan" | "task" | "opportunity", id: string) =>
      // @ts-expect-error 三张表都有 ownerId
      (await prisma[m].findUniqueOrThrow({ where: { id } })).ownerId as string;
    return { 计划, 待办, 做完的, 别人的, 在谈, 赢单, 王五, 主 };
  }

  it("详情页单格改负责人：没做完的计划、待办、在谈商机转给李四；做完的、赢单的、别人的不动", async () => {
    const { 计划, 待办, 做完的, 别人的, 在谈, 赢单, 王五, 主 } = await 摆活();
    const r = await patchCustomer(客户.id, "salesOwnerId", 李四.id);
    expect(r).toMatchObject({ ok: true, 带走: { 计划和待办: 2, 商机: 1 } });
    expect(await 主("followPlan", 计划.id)).toBe(李四.id);
    expect(await 主("task", 待办.id)).toBe(李四.id);
    expect(await 主("opportunity", 在谈.id)).toBe(李四.id);
    expect(await 主("task", 做完的.id)).toBe(张三.id);
    expect(await 主("opportunity", 赢单.id)).toBe(张三.id);
    expect(await 主("task", 别人的.id)).toBe(王五.id);
  });

  it("列表批量转给李四：一样带走，结果里说得出带走了几条", async () => {
    const { 计划, 主 } = await 摆活();
    const r = await assignSalesOwner([客户.id], 李四.id);
    expect(r).toMatchObject({ ok: true, updated: 1, 带走: { 计划和待办: 2, 商机: 1 } });
    expect(await 主("followPlan", 计划.id)).toBe(李四.id);
  });
});


/*
  T-030（2026-10-04 工作室试用前）：数据页「按人」的数点进去，原来跳 /customers?salesOwnerId=——
  上面按签约那一刻的负责人、限了时间段，点进去按现在的负责人、不限时间，人数对不上。
  现在点名字就地打开这个人这一段的签约明细，和那一行同一个口径。
*/
describe("T-030 按人点进去的明细和那一行同一个口径", () => {
  it("客户转给李四之后：张三那一行 1 笔 50 万，点进去也是这 1 笔；李四一笔都没有", async () => {
    await assignSalesOwner([客户.id], 李四.id);
    const r = await 加载复盘(今年.from, 今年.to, "month");
    const 张三行 = r.bySales.find((x) => x.id === 张三.id)!;
    const 张三的 = 按人明细(r.明细, "销售", 张三.id);
    expect(张三的.length).toBe(张三行.count);
    expect(张三的.reduce((s, x) => s + x.金额, 0)).toBe(张三行.amount);
    expect(按人明细(r.明细, "销售", 李四.id)).toEqual([]);
    // 渠道负责人那张表也一样
    const 渠道行 = r.byChannelOwner.find((x) => x.id === 张三.id)!;
    expect(按人明细(r.明细, "渠道负责人", 张三.id).length).toBe(渠道行.count);
  });

  it("时间段外的签约不算进去（明细只有这一段的）", async () => {
    await saveContract({ customerId: 客户.id, amount: 1000, signedAt: new Date("2025-06-01"), remark: null });
    const r = await 加载复盘(今年.from, 今年.to, "month");
    expect(按人明细(r.明细, "销售", 张三.id).map((x) => x.金额)).toEqual([500000]);
  });
});
