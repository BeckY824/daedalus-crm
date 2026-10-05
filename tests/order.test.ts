/**
 * 外贸订单 + 12 节点（2026-10-03 外贸第 3a 块）。
 *   - 规则：当前节点 = 第一个没完成也不是不适用的；红黄绿灰；进度不算不适用；钱；默认订单号；按条款给单据
 *   - 从赢单商机生成：带金额币种、前四步记完成、同一个商机只一张；单据按条款
 *   - 节点：改状态记 / 清完成时刻；非法状态拦；记一笔 = 一条跟进 + 挂在节点上
 *   - 钱：定金不能比金额多
 *   - 删订单：节点单据跟着删，跟进记录留着
 *   - AI：list_orders 给当前节点、超期的节点、未收
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人, 造客户 } from "./r2-data-helpers";
import { saveOpportunity } from "@/app/(app)/opportunities/actions";
import { createOrder, saveOrder, saveOrderNode, saveOrderDoc, addOrderDoc, deleteOrderDoc, addOrderNodeNote, deleteOrder } from "@/app/(app)/orders/actions";
import { 当前节点, 节点灯, 进度, 超期数, 订单的钱, 默认订单号, 默认单据, 节点名们, 定金比例, 团队订单前缀 } from "@/lib/order";
import { 订单列表, 订单详情 } from "@/lib/order-db";
import { TOOLS } from "@/lib/agent/tools";
import { DEFAULT_BUSINESS } from "@/lib/business-config";
import { 订单节点 } from "@/lib/features";

let 我: string;
beforeEach(async () => {
  await resetDb();
  我 = (await 造本人()).id;
  mocks.user = { ...mocks.user, id: 我 };
});
afterAll(async () => { await prisma.$disconnect(); });

const 天 = (n: number, 从 = new Date(2026, 9, 10, 12)) => new Date(从.getTime() + n * 86400000).toISOString();
const 今天 = new Date(2026, 9, 10, 12);

describe("规则", () => {
  it("当前节点：第一个没完成、也不是不适用的；全走完是 null", () => {
    const n = (idx: number, status: string) => ({ idx, status });
    expect(当前节点([n(2, "未开始"), n(1, "已完成")])?.idx).toBe(2);
    expect(当前节点([n(1, "不适用"), n(2, "卡住"), n(3, "未开始")])?.idx).toBe(2);
    expect(当前节点([n(1, "已完成"), n(2, "不适用")])).toBeNull();
  });

  it("颜色：完成绿、不适用灰、卡住红、过了截止日红、3 天内黄、截止日当天黄不红", () => {
    expect(节点灯({ status: "已完成", dueAt: 天(-5) }, 今天)).toBe("绿");
    expect(节点灯({ status: "不适用", dueAt: 天(-5) }, 今天)).toBe("灰");
    expect(节点灯({ status: "卡住", dueAt: null }, 今天)).toBe("红");
    expect(节点灯({ status: "进行中", dueAt: 天(-1) }, 今天)).toBe("红");
    expect(节点灯({ status: "未开始", dueAt: 天(0) }, 今天)).toBe("黄");
    expect(节点灯({ status: "未开始", dueAt: 天(3) }, 今天)).toBe("黄");
    expect(节点灯({ status: "未开始", dueAt: 天(4) }, 今天)).toBe("无");
    expect(节点灯({ status: "未开始", dueAt: null }, 今天)).toBe("无");
    expect(超期数([{ status: "卡住", dueAt: null }, { status: "进行中", dueAt: 天(-2) }, { status: "已完成", dueAt: 天(-2) }], 今天)).toBe(2);
  });

  it("进度不算不适用的；钱：尾款应收 = 金额 - 定金应收，未收不小于 0", () => {
    expect(进度([{ status: "已完成" }, { status: "不适用" }, { status: "未开始" }])).toBe(50);
    expect(进度([{ status: "不适用" }])).toBe(100);
    expect(订单的钱({ amount: 10000, depositDue: 3000, depositPaid: 3000, balancePaid: 2000 })).toEqual({ 尾款应收: 7000, 未收: 5000 });
    expect(订单的钱({ amount: 100, depositDue: 30, depositPaid: 80, balancePaid: 80 }).未收).toBe(0);
  });

  it("付款方式读定金比例：T/T 30/70 是 0.3，全款前是 1，L/C 读不出", () => {
    expect(定金比例("T/T 30/70")).toBe(0.3);
    expect(定金比例("TT 50 / 50")).toBe(0.5);
    expect(定金比例("T/T 100% 前")).toBe(1);
    expect(定金比例("L/C at sight")).toBeNull();
    expect(定金比例("30/60")).toBeNull();
    expect(定金比例(null)).toBeNull();
  });

  it("团队模式下订单号带下单人名字的第一个字：几台电脑各编各的不撞号", () => {
    expect(团队订单前缀("甲")).toBe("甲-");
    expect(团队订单前缀("  Alice")).toBe("A-");
    expect(团队订单前缀("")).toBe("");
    expect(默认订单号(["甲-20261010-1"], 今天, "甲-")).toBe("甲-20261010-2");
  });

  it("默认订单号按日期编号，同一天往后排；单据按贸易条款", () => {
    expect(默认订单号([], 今天)).toBe("20261010-1");
    expect(默认订单号(["20261010-1", "20261010-2"], 今天)).toBe("20261010-3");
    expect(默认单据("EXW")).not.toContain("订舱单 S/O");
    expect(默认单据("EXW")).not.toContain("提单 B/L");
    expect(默认单据("CIF")).toContain("保险单");
    expect(默认单据("FOB")).not.toContain("保险单");
    expect(默认单据(null)).toEqual(默认单据("FOB"));
  });
});

async function 赢单商机(customerId: string) {
  const r = await saveOpportunity({ name: "面板灯", customerId, amount: 7100, currency: "USD", stage: "赢单成交", status: "WON", probability: 100, ownerId: 我 });
  if (!r.ok) throw new Error(r.error);
  return prisma.opportunity.findFirstOrThrow({ where: { customerId } });
}

describe("生成订单", () => {
  it("从赢单商机来：金额币种带过去、前四步已完成、业务员是商机负责人、单据按条款", async () => {
    const c = await 造客户(我);
    const o = await 赢单商机(c.id);
    const r = await createOrder({ customerId: c.id, opportunityId: o.id, incoterm: "exw" });
    if (!r.ok) throw new Error(r.error);
    const d = (await 订单详情(r.id))!;
    expect(d).toMatchObject({ amount: 7100, currency: "USD", incoterm: "EXW", ownerName: "我" });
    expect(d.no).toMatch(/^\d{8}-1$/);
    expect(d.nodes.map((n) => n.status)).toEqual([...Array(4).fill("已完成"), ...Array(8).fill("未开始")]);
    expect(d.nodes.map((n) => n.name)).toEqual([...节点名们]);
    expect(d.docs.map((x) => x.name)).toEqual(默认单据("EXW"));
    expect(当前节点(d.nodes)?.name).toBe("收定金");
  });

  it("同一个商机只生成一张：再点一次还回那一张", async () => {
    const c = await 造客户(我);
    const o = await 赢单商机(c.id);
    const a = await createOrder({ customerId: c.id, opportunityId: o.id });
    const b = await createOrder({ customerId: c.id, opportunityId: o.id });
    expect(a.ok && b.ok && a.id === b.id).toBe(true);
    expect(b).toMatchObject({ 已有: true });
    expect(await prisma.tradeOrder.count()).toBe(1);
  });

  it("不是这位客户的商机拦下；没有商机也能建，12 步都从未开始起", async () => {
    const 甲 = await 造客户(我);
    const 乙 = await 造客户(我);
    const o = await 赢单商机(甲.id);
    expect((await createOrder({ customerId: 乙.id, opportunityId: o.id })).ok).toBe(false);
    const r = await createOrder({ customerId: 乙.id, amount: 500, currency: "eur", no: "PI-001" });
    if (!r.ok) throw new Error(r.error);
    const d = (await 订单详情(r.id))!;
    expect(d).toMatchObject({ no: "PI-001", currency: "EUR", amount: 500 });
    expect(d.nodes.every((n) => n.status === "未开始")).toBe(true);
  });

  it("定金比金额多拦下；币种认不得拦下", async () => {
    const c = await 造客户(我);
    expect(await createOrder({ customerId: c.id, amount: 100, depositDue: 200 })).toEqual({ ok: false, error: "定金比订单金额还多" });
    expect(await createOrder({ customerId: c.id, amount: 100, currency: "XYZ" })).toEqual({ ok: false, error: "不认识这个币种" });
    const r = await createOrder({ customerId: c.id, amount: 100, depositDue: 30 });
    if (!r.ok) throw new Error(r.error);
    expect(await saveOrder(r.id, { amount: 20 })).toEqual({ ok: false, error: "定金比订单金额还多" });
  });
});

describe("节点、单据、钱", () => {
  async function 一单() {
    const c = await 造客户(我);
    const r = await createOrder({ customerId: c.id, amount: 10000, currency: "USD", depositDue: 3000 });
    if (!r.ok) throw new Error(r.error);
    return { c, id: r.id };
  }

  it("改成已完成记下时刻，改回去清掉；状态不对拦下；改名 / 截止日留日志", async () => {
    const { id } = await 一单();
    expect((await saveOrderNode(id, 5, { status: "已完成" })).ok).toBe(true);
    let n = await prisma.tradeOrderNode.findUniqueOrThrow({ where: { orderId_idx: { orderId: id, idx: 5 } } });
    expect(n.doneAt).not.toBeNull();
    await saveOrderNode(id, 5, { status: "进行中" });
    n = await prisma.tradeOrderNode.findUniqueOrThrow({ where: { orderId_idx: { orderId: id, idx: 5 } } });
    expect(n.doneAt).toBeNull();
    expect((await saveOrderNode(id, 5, { status: "完成啦" })).ok).toBe(false);
    expect((await saveOrderNode(id, 9, { name: "订舱（货代：XX）", dueAt: "2026-10-20" })).ok).toBe(true);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { summary: { contains: "第 9 步" } } });
    expect(log.summary).toContain("改名为「订舱（货代：XX）」");
    expect((await saveOrderNode(id, 99, { status: "已完成" })).ok).toBe(false);
  });

  it("在节点上记一笔：是一条跟进（客户时间线里有），挂在这一步上", async () => {
    const { c, id } = await 一单();
    const r = await addOrderNodeNote(id, 7, "工厂说 10-25 货好");
    expect(r.ok).toBe(true);
    const f = await prisma.followUp.findFirstOrThrow({ where: { customerId: c.id }, include: { orderNode: true } });
    expect(f).toMatchObject({ content: "工厂说 10-25 货好", type: "OTHER" });
    expect(f.title).toContain("生产跟进");
    expect(f.orderNode).toMatchObject({ orderId: id, nodeIdx: 7 });
    expect((await 订单详情(id))!.notes.map((x) => [x.nodeIdx, x.content])).toEqual([[7, "工厂说 10-25 货好"]]);
    expect((await addOrderNodeNote(id, 7, "   ")).ok).toBe(false);
  });

  it("单据：改状态、加一样（重名拦）、删一样", async () => {
    const { id } = await 一单();
    const 第一 = (await prisma.tradeOrderDoc.findFirstOrThrow({ where: { orderId: id }, orderBy: { sort: "asc" } }));
    expect((await saveOrderDoc(第一.id, "已发客户")).ok).toBe(true);
    expect((await saveOrderDoc(第一.id, "丢了")).ok).toBe(false);
    expect((await addOrderDoc(id, "产地证 CO")).ok).toBe(true);
    expect(await addOrderDoc(id, "产地证 CO")).toEqual({ ok: false, error: "已经有「产地证 CO」了" });
    const co = await prisma.tradeOrderDoc.findFirstOrThrow({ where: { orderId: id, name: "产地证 CO" } });
    expect(co.sort).toBe(默认单据("FOB").length);
    expect((await deleteOrderDoc(co.id)).ok).toBe(true);
    expect(await prisma.tradeOrderDoc.count({ where: { orderId: id } })).toBe(默认单据("FOB").length);
  });

  it("钱：实收和到账日；日期不对拦下；列表里未收跟着变", async () => {
    const { id } = await 一单();
    expect((await saveOrder(id, { depositPaid: 3000, depositAt: "2026-10-05" })).ok).toBe(true);
    expect((await saveOrder(id, { balanceAt: "哪天" })).ok).toBe(false);
    const [行] = await 订单列表();
    expect(行.未收).toBe(7000);
  });

  it("删订单：节点、单据跟着删；记过的跟进留在客户那儿", async () => {
    const { c, id } = await 一单();
    await addOrderNodeNote(id, 6, "给工厂下了单");
    expect((await deleteOrder(id)).ok).toBe(true);
    expect(await prisma.tradeOrderNode.count()).toBe(0);
    expect(await prisma.tradeOrderDoc.count()).toBe(0);
    expect(await prisma.followUp.count({ where: { customerId: c.id } })).toBe(1);
  });
});

describe("一览和 AI", () => {
  // 节点开着时 list_orders 才说节点；关着时只给订单上那几项（2026-10-05，tests/trade-feedback.test.ts 钉着）
  it.runIf(订单节点)("超期多的排上面；list_orders 给当前节点、超期的节点、未收，onlyLate 只看超期的", async () => {
    const 甲 = await 造客户(我, { name: "Acme" });
    const 乙 = await 造客户(我, { name: "Bolt" });
    const 准时 = await createOrder({ customerId: 甲.id, amount: 100, currency: "USD", no: "A-1" });
    const 拖了 = await createOrder({ customerId: 乙.id, amount: 200, currency: "USD", no: "B-1" });
    if (!准时.ok || !拖了.ok) throw new Error("建不了");
    await saveOrderNode(拖了.id, 1, { dueAt: "2020-01-01" });
    const 列 = await 订单列表();
    expect(列.map((r) => r.no)).toEqual(["B-1", "A-1"]);
    const ctx = { userId: 我, userName: "我", b: DEFAULT_BUSINESS, recordOffset: 0, proposals: [] };
    const 工具 = TOOLS.find((t) => t.name === "list_orders")!;
    const 全 = await 工具.run({}, ctx);
    expect(全.summary).toBe("2 张订单，其中 1 张有超期");
    const 超 = await 工具.run({ onlyLate: true }, ctx);
    expect(超.data).toEqual([expect.objectContaining({ 订单号: "B-1", 客户: "Bolt", 当前节点: "1. 询盘", 超期的节点: ["1. 询盘（未开始，截止 2020-01-01）"], 未收: "US$ 200" })]);
    const 按客户 = await 工具.run({ customerName: "Acme" }, ctx);
    expect((按客户.data as { 订单号: string }[]).map((x) => x.订单号)).toEqual(["A-1"]);
  });
});
