/**
 * 供应商档案 + 比价 + 订单采购（2026-10-03 外贸第 3c 块）。
 *   - 规则：同产品同币种同含票里最低价（并列都算、一家不算、淘汰不算）；建议报价；毛利；过期
 *   - 档案：同名拦；评级只认 A/B/C；删前清点
 *   - 比价：只给名字就顺手建一家（同名复用）；选用 / 淘汰要理由；数不对拦
 *   - 订单：生成时带上「选用」的供应商；采购额 + 汇率 → 毛利；删供应商订单只是没了供应商
 *   - AI：list_suppliers 按产品筛、带最近比价
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null },
}));
// 此套件验证高级功能启用时的实现；默认关闭的服务端拒绝由remediation-feature-access单独覆盖。
vi.mock("@/lib/features", async (original) => ({ ...(await original<object>()), 订单节点: true, 供应商页: true, 报价明细: true }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人, 造客户 } from "./r2-data-helpers";
import { saveOpportunity } from "@/app/(app)/opportunities/actions";
import { saveSupplier, saveSupplierQuote, deleteSupplierQuote, deleteSupplier, 删供应商前清点, 读比价 } from "@/app/(app)/suppliers/actions";
import { createOrder, saveOrderPurchase } from "@/app/(app)/orders/actions";
import { 最低价, 建议报价, 毛利, 过期了 } from "@/lib/supplier";
import { 订单详情 } from "@/lib/order-db";
import { 供应商列表, 供应商详情 } from "@/lib/supplier-db";
import { TOOLS } from "@/lib/agent/tools";
import { DEFAULT_BUSINESS } from "@/lib/business-config";

let 我: string;
beforeEach(async () => {
  await resetDb();
  我 = (await 造本人()).id;
  mocks.user = { ...mocks.user, id: 我 };
});
afterAll(async () => { await prisma.$disconnect(); });

describe("规则", () => {
  const 行 = (id: string, p: Partial<{ product: string; unitPrice: number; currency: string; withInvoice: boolean; verdict: string }>) => ({ id, product: "灯", unitPrice: 1, currency: "CNY", withInvoice: true, ...p });
  it("最低价：同产品同币种同口径里比；并列都算；只有一家、淘汰的、口径不同的不比", () => {
    const 低 = 最低价([
      行("a", { unitPrice: 20 }), 行("b", { unitPrice: 18 }), 行("c", { unitPrice: 18 }),
      行("d", { unitPrice: 15, withInvoice: false }),
      行("e", { unitPrice: 10, verdict: "淘汰" }),
      行("f", { product: "支架", unitPrice: 2 }),
      行("g", { product: " 灯 ", unitPrice: 30, currency: "USD" }),
    ]);
    expect([...低].sort()).toEqual(["b", "c"]);
  });

  it("建议报价 = 出厂价 ÷ 汇率 ÷ (1 − 毛利率)；参数不对给 null", () => {
    expect(建议报价(21.3, 7.1, 0.25)).toBe(4);
    expect(建议报价(21.3, 7.1, 0)).toBe(3);
    expect(建议报价(21.3, null, 0.2)).toBeNull();
    expect(建议报价(21.3, 7.1, 1)).toBeNull();
  });

  it("毛利：不同币要汇率，同币不用；缺一样算不出来", () => {
    expect(毛利({ amount: 1000, currency: "USD" }, { cost: 5680, currency: "CNY", fxRate: 7.1 })).toEqual({ 毛利: 1420, 毛利率: 20, 币种: "CNY" });
    expect(毛利({ amount: 1000, currency: "CNY" }, { cost: 800, currency: "CNY", fxRate: null })).toEqual({ 毛利: 200, 毛利率: 20, 币种: "CNY" });
    expect(毛利({ amount: 1000, currency: "USD" }, { cost: 800, currency: "CNY", fxRate: null })).toBeNull();
    expect(毛利({ amount: 1000, currency: "USD" }, null)).toBeNull();
  });

  it("过期按日历天：有效期当天还算数", () => {
    const 今天 = new Date(2026, 9, 10, 15);
    expect(过期了(new Date(2026, 9, 10, 0), 今天)).toBe(false);
    expect(过期了(new Date(2026, 9, 9, 23), 今天)).toBe(true);
    expect(过期了(null, 今天)).toBe(false);
  });
});

async function 一个商机() {
  const c = await 造客户(我);
  const r = await saveOpportunity({ name: "面板灯询盘", customerId: c.id, amount: 7100, currency: "USD", stage: "方案报价", status: "OPEN", probability: 50, ownerId: 我 });
  if (!r.ok) throw new Error(r.error);
  return { c, o: await prisma.opportunity.findFirstOrThrow({ where: { customerId: c.id } }) };
}
const 比 = (opportunityId: string, p: Record<string, unknown> = {}) =>
  saveSupplierQuote({ opportunityId, supplierName: "明亮灯饰厂", product: "LED 面板灯", unitPrice: 21.3, currency: "CNY", withInvoice: true, ...p });

describe("档案和比价", () => {
  it("档案：同名拦、评级只认 A/B/C", async () => {
    expect((await saveSupplier({ name: "明亮灯饰厂", rating: "A" })).ok).toBe(true);
    expect(await saveSupplier({ name: " 明亮灯饰厂 " })).toEqual({ ok: false, error: "已经有一家叫「明亮灯饰厂」的供应商了" });
    expect((await saveSupplier({ name: "别家", rating: "S" })).ok).toBe(false);
  });

  it("比价只给名字：没有就建一家，同名复用；选用 / 淘汰要理由；负数拦", async () => {
    const { o } = await 一个商机();
    expect((await 比(o.id)).ok).toBe(true);
    expect((await 比(o.id, { unitPrice: 20.5, withInvoice: false })).ok).toBe(true);
    expect(await prisma.supplier.count()).toBe(1);
    expect(await 比(o.id, { verdict: "选用" })).toEqual({ ok: false, error: "「选用」要写一句理由" });
    expect((await 比(o.id, { supplierName: "古镇二厂", unitPrice: 19.8, verdict: "选用", reason: "价低、交期 25 天" })).ok).toBe(true);
    expect((await 比(o.id, { unitPrice: -1 })).ok).toBe(false);
    expect((await 比(o.id, { verdict: "随便" })).ok).toBe(false);
    const d = await 读比价(o.id);
    expect(d.行).toHaveLength(3);
    expect(d.供应商.map((s) => s.name).sort()).toEqual(["古镇二厂", "明亮灯饰厂"]);
    // 最低价：含票的两行里古镇二厂 19.8 最低；不含票那一行自己一组不比
    expect([...最低价(d.行)].map((id) => d.行.find((r) => r.id === id)!.supplier.name)).toEqual(["古镇二厂"]);
  });

  it("比价抽屉的产品下拉：商机当前报价里的产品", async () => {
    const { o, c } = await 一个商机();
    await saveOpportunity({ id: o.id, name: "面板灯询盘", customerId: c.id, amount: 7100, stage: "方案报价", status: "OPEN", probability: 50, ownerId: 我, 报价: [{ product: "LED 面板灯", qty: 2000, unitPrice: 3.2 }, { product: "安装支架", qty: 2000, unitPrice: 0.35 }] });
    expect((await 读比价(o.id)).产品).toEqual(["LED 面板灯", "安装支架"]);
  });

  it("删一行比价；删供应商前清点、比价跟着删", async () => {
    const { o } = await 一个商机();
    const r = await 比(o.id);
    if (!r.ok) throw new Error(r.error);
    await 比(o.id, { unitPrice: 22 });
    expect((await deleteSupplierQuote(r.id)).ok).toBe(true);
    const s = await prisma.supplier.findFirstOrThrow();
    expect(await 删供应商前清点(s.id)).toEqual({ 比价: 1, 订单: 0 });
    expect((await deleteSupplier(s.id)).ok).toBe(true);
    expect(await prisma.supplierQuote.count()).toBe(0);
  });
});

describe("订单的采购", () => {
  it("从商机生成订单：带上「选用」的那家；填采购额和汇率出毛利；删供应商订单只是没了供应商", async () => {
    const { o, c } = await 一个商机();
    await 比(o.id, { supplierName: "古镇二厂", unitPrice: 19.8, verdict: "选用", reason: "价低" });
    await prisma.opportunity.update({ where: { id: o.id }, data: { status: "WON", stage: "赢单成交" } });
    const r = await createOrder({ customerId: c.id, opportunityId: o.id });
    if (!r.ok) throw new Error(r.error);
    let d = (await 订单详情(r.id))!;
    expect(d.采购).toMatchObject({ supplierName: "古镇二厂", cost: 0, currency: "CNY" });
    expect((await saveOrderPurchase(r.id, { supplierId: d.采购!.supplierId, cost: 40000, currency: "CNY", fxRate: 7.1 })).ok).toBe(true);
    d = (await 订单详情(r.id))!;
    expect(毛利(d, d.采购)).toEqual({ 毛利: 10410, 毛利率: 20.7, 币种: "CNY" });
    expect((await saveOrderPurchase(r.id, { cost: 1, fxRate: 0 })).ok).toBe(false);
    const [行] = await 供应商列表();
    expect(行).toMatchObject({ name: "古镇二厂", 合作单数: 1, 比价: 1, 选用: 1 });
    expect((await 供应商详情(行.id))!.purchases.map((p) => p.no)).toEqual([d.no]);
    await deleteSupplier(行.id);
    expect((await 订单详情(r.id))!.采购).toMatchObject({ supplierId: null, cost: 40000 });
  });
});

describe("AI", () => {
  it("list_suppliers：按产品筛，带最近比价和出过的问题", async () => {
    const { o } = await 一个商机();
    await saveSupplier({ name: "明亮灯饰厂", rating: "B", issues: "2026-08 那单延期 10 天" });
    await 比(o.id, { verdict: "淘汰", reason: "上次延期" });
    await 比(o.id, { supplierName: "古镇二厂", product: "安装支架", unitPrice: 2.4 });
    const ctx = { userId: 我, userName: "我", b: DEFAULT_BUSINESS, recordOffset: 0, proposals: [] };
    const r = await TOOLS.find((t) => t.name === "list_suppliers")!.run({ product: "面板灯" }, ctx);
    const data = r.data as { 名称: string; 出过的问题: string; 最近比价: string[] }[];
    expect(data.map((x) => x.名称)).toEqual(["明亮灯饰厂"]);
    expect(data[0].出过的问题).toContain("延期");
    expect(data[0].最近比价[0]).toContain("LED 面板灯 ¥ 21.30（含票） · 淘汰（上次延期）");
  });
});
