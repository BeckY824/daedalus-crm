import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ user: { id: "", name: "QA", email: "qa", role: "ADMIN", title: "管理员" } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => state.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache } from "@/lib/settings";
import { 订单节点, 供应商页, 报价明细 } from "@/lib/features";
import { createOrder, saveOrder, saveOrderNode, saveOrderDoc, addOrderDoc, deleteOrderDoc, addOrderNodeNote, saveOrderPurchase } from "@/app/(app)/orders/actions";
import { saveSupplier, deleteSupplier, saveSupplierQuote, deleteSupplierQuote, 读比价 } from "@/app/(app)/suppliers/actions";
import { saveOpportunity, 读报价 } from "@/app/(app)/opportunities/actions";

let ids: { customer: string; opportunity: string; order: string; doc: string; supplier: string; quote: string };
beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  const user = await prisma.user.create({ data: { email: "qa-features", name: "QA", role: "ADMIN", password: "unused" } });
  state.user.id = user.id;
  const c = await prisma.customer.create({ data: { name: "QA-客户", phone: "", salesOwnerId: user.id } });
  const o = await prisma.opportunity.create({ data: { name: "QA-商机", customerId: c.id, ownerId: user.id } });
  const supplier = await prisma.supplier.create({ data: { name: "QA-供应商" } });
  const order = await prisma.tradeOrder.create({ data: { no: "QA-ORDER", customerId: c.id, ownerId: user.id, nodes: { create: { idx: 1, name: "QA-节点" } }, docs: { create: { name: "QA-单据", sort: 0 } }, purchase: { create: { supplierId: supplier.id, cost: 1 } } }, include: { docs: true } });
  const quote = await prisma.supplierQuote.create({ data: { opportunityId: o.id, supplierId: supplier.id, product: "QA-产品", unitPrice: 1 } });
  ids = { customer: c.id, opportunity: o.id, order: order.id, doc: order.docs[0].id, supplier: supplier.id, quote: quote.id };
});
afterAll(async () => { await prisma.$disconnect(); });

async function snapshot() {
  return JSON.stringify(await Promise.all([
    prisma.supplier.findMany(), prisma.supplierQuote.findMany(), prisma.tradeOrder.findMany(),
    prisma.tradeOrderNode.findMany(), prisma.tradeOrderDoc.findMany(), prisma.tradeOrderPurchase.findMany(),
    prisma.opportunity.findMany(), prisma.quote.findMany(), prisma.followUp.findMany(), prisma.auditLog.findMany(),
  ]));
}

describe("L-110/W-050 关闭功能的服务端同样拒绝", () => {
  // 每条带上挡它的开关：开关打开了（0.46.30 起订单节点打开）那条就不该再拒，跳过
  const 情形 = [
    ["旧高级新建订单", () => createOrder({ customerId: ids.customer, no: "QA-NEW" }), 订单节点],
    ["改定金", () => saveOrder(ids.order, { depositPaid: 100 }), 订单节点],
    ["改采购", () => saveOrderPurchase(ids.order, { cost: 200 }), 供应商页],
    ["改节点", () => saveOrderNode(ids.order, 1, { status: "已完成" }), 订单节点],
    ["改单据", () => saveOrderDoc(ids.doc, "已收齐"), 订单节点],
    ["加单据", () => addOrderDoc(ids.order, "QA-新单据"), 订单节点],
    ["删单据", () => deleteOrderDoc(ids.doc), 订单节点],
    ["节点记跟进", () => addOrderNodeNote(ids.order, 1, "QA-节点跟进"), 订单节点],
    ["改供应商", () => saveSupplier({ id: ids.supplier, name: "QA-已修改" }), 供应商页],
    ["删供应商", () => deleteSupplier(ids.supplier), 供应商页],
    ["存比价", () => saveSupplierQuote({ opportunityId: ids.opportunity, supplierId: ids.supplier, product: "QA-新产品", unitPrice: 20 }), 供应商页],
    ["删比价", () => deleteSupplierQuote(ids.quote), 供应商页],
    ["保存关闭的报价明细", () => saveOpportunity({ id: ids.opportunity, name: "QA-商机修改", customerId: ids.customer, ownerId: state.user.id, amount: 1, stage: "初步沟通", status: "OPEN", probability: 20, 报价: [{ product: "QA", qty: 1, unitPrice: 1 }] }), 报价明细],
  ] as const;
  const 关着的 = 情形.filter(([, , 开]) => !开).map(([名, 做]) => [名, 做] as const);
  it.each(关着的)("%s：拒绝且业务库完全不变", async (_label, operation) => {
    const before = await snapshot();
    expect(await operation()).toMatchObject({ ok: false, error: expect.stringContaining("未开放") });
    expect(await snapshot()).toBe(before);
  });

  it("关闭的只读高级入口不返回遗留明细", async () => {
    expect(await 读报价(ids.opportunity)).toEqual([]);
    expect(await 读比价(ids.opportunity)).toEqual({ 行: [], 供应商: [], 产品: [] });
  });
});
