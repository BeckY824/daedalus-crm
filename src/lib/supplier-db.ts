/**
 * 供应商的读（2026-10-03 外贸第 3c 块）。写在 app/(app)/suppliers/actions.ts，规则在 lib/supplier.ts。
 */
import type { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import { 规整币种 } from "./currency";

export type 供应商行 = {
  id: string; name: string; category: string | null; region: string | null; contact: string | null; phone: string | null;
  invoice: string | null; rating: string | null; issues: string | null;
  比价: number; 选用: number; 合作单数: number; 最近报价: string | null;
};

/** 供应商一览：合作过几单（订单采购指向它）、比过几次价、被选用几次。评级好的、合作多的排前面 */
export async function 供应商列表(where: Prisma.SupplierWhereInput = {}): Promise<供应商行[]> {
  const rows = await prisma.supplier.findMany({
    where,
    take: 500,
    include: {
      _count: { select: { quotes: true, purchases: true } },
      quotes: { orderBy: { quotedAt: "desc" }, take: 1, select: { quotedAt: true } },
    },
  });
  const 选用 = new Map((await prisma.supplierQuote.groupBy({ by: ["supplierId"], where: { verdict: "选用" }, _count: { _all: true } })).map((g) => [g.supplierId, g._count._all]));
  const 级 = (r: string | null) => ({ A: 0, B: 1, C: 2 })[r ?? ""] ?? 3;
  return rows
    .map((s) => ({
      id: s.id, name: s.name, category: s.category, region: s.region, contact: s.contact, phone: s.phone,
      invoice: s.invoice, rating: s.rating, issues: s.issues,
      比价: s._count.quotes, 选用: 选用.get(s.id) ?? 0, 合作单数: s._count.purchases,
      最近报价: s.quotes[0]?.quotedAt.toISOString() ?? null,
    }))
    .sort((a, b) => 级(a.rating) - 级(b.rating) || b.合作单数 - a.合作单数 || a.name.localeCompare(b.name, "zh-CN"));
}

/** 一家供应商：档案、历次比价（哪个询盘、什么产品、多少钱、结论）、从它这儿采过的订单 */
export async function 供应商详情(id: string) {
  const s = await prisma.supplier.findUnique({
    where: { id },
    include: {
      quotes: { orderBy: { quotedAt: "desc" }, take: 200, include: { opportunity: { select: { id: true, name: true, customer: { select: { id: true, name: true } } } } } },
      purchases: { include: { order: { select: { id: true, no: true, amount: true, currency: true, createdAt: true, customer: { select: { name: true } } } } } },
    },
  });
  if (!s) return null;
  return {
    ...s,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    quotes: s.quotes.map((q) => ({
      id: q.id, product: q.product, unitPrice: q.unitPrice, currency: 规整币种(q.currency), withInvoice: q.withInvoice, moq: q.moq, leadDays: q.leadDays,
      validUntil: q.validUntil?.toISOString() ?? null, quotedAt: q.quotedAt.toISOString(), verdict: q.verdict, reason: q.reason,
      商机: q.opportunity.name, 商机id: q.opportunity.id, 客户: q.opportunity.customer.name,
    })),
    purchases: s.purchases
      .map((p) => ({ orderId: p.order.id, no: p.order.no, 客户: p.order.customer.name, amount: p.order.amount, currency: 规整币种(p.order.currency), cost: p.cost, costCurrency: 规整币种(p.currency), createdAt: p.order.createdAt.toISOString() }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

export type 供应商详情数据 = NonNullable<Awaited<ReturnType<typeof 供应商详情>>>;
