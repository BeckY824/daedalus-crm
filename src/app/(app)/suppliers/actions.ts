"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { 不在了 } from "@/lib/not-there";
import { 是币种, 规整币种, 金额 as 显示金额 } from "@/lib/currency";
import { 结论们, 要理由, 评级们 } from "@/lib/supplier";

/**
 * 供应商档案和比价的写操作（2026-10-03 外贸第 3c 块）。规则在 lib/supplier.ts。
 */

const 文本 = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const 可空文本 = (v: unknown, max: number) => 文本(v, max) || null;
const 非负 = (v: unknown): number | null | "坏" => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1e12 ? n : "坏";
};

function 刷新(供应商id?: string) {
  revalidatePath("/suppliers");
  if (供应商id) revalidatePath(`/suppliers/${供应商id}`);
  revalidatePath("/opportunities");
}

export type 供应商输入 = {
  id?: string;
  name: string;
  category?: string | null;
  region?: string | null;
  contact?: string | null;
  phone?: string | null;
  wechat?: string | null;
  invoice?: string | null;
  payment?: string | null;
  rating?: string | null;
  issues?: string | null;
  remark?: string | null;
};

export async function saveSupplier(input: 供应商输入) {
  try {
    const me = await requireUser();
    const name = 文本(input.name, 60);
    if (!name) return { ok: false as const, error: "请填供应商名称" };
    if (input.rating && !评级们.some((x) => x.value === input.rating)) return { ok: false as const, error: "评级只能是 A / B / C" };
    const data = {
      name,
      category: 可空文本(input.category, 60),
      region: 可空文本(input.region, 60),
      contact: 可空文本(input.contact, 40),
      phone: 可空文本(input.phone, 40),
      wechat: 可空文本(input.wechat, 60),
      invoice: 可空文本(input.invoice, 40),
      payment: 可空文本(input.payment, 60),
      rating: input.rating || null,
      issues: 可空文本(input.issues, 2000),
      remark: 可空文本(input.remark, 2000),
    };
    // 同名的不另建：比价抽屉里随手敲名字建的，和档案页建的应该是同一家
    const 重名 = await prisma.supplier.findFirst({ where: { name, ...(input.id ? { id: { not: input.id } } : {}) }, select: { id: true } });
    if (重名) return { ok: false as const, error: `已经有一家叫「${name}」的供应商了` };
    const s = input.id ? await prisma.supplier.update({ where: { id: input.id }, data }) : await prisma.supplier.create({ data });
    await recordAudit({ user: me, action: input.id ? "update" : "create", entity: "Supplier", entityId: s.id, summary: `${input.id ? "修改" : "新建"}供应商「${s.name}」`, detail: data });
    刷新(s.id);
    return { ok: true as const, id: s.id };
  } catch (e) {
    return 不在了(e);
  }
}

/** 删之前数一下：比价记录跟着删，订单上的采购只是不再指向它 */
export async function 删供应商前清点(id: string) {
  await requireUser();
  const [比价, 订单] = await Promise.all([
    prisma.supplierQuote.count({ where: { supplierId: String(id ?? "") } }),
    prisma.tradeOrderPurchase.count({ where: { supplierId: String(id ?? "") } }),
  ]);
  return { 比价, 订单 };
}

export async function deleteSupplier(id: string) {
  try {
    const me = await requireUser();
    const s = await prisma.supplier.findUnique({ where: { id: String(id ?? "") } });
    if (!s) return { ok: true as const };
    await prisma.supplier.delete({ where: { id: s.id } });
    await recordAudit({ user: me, action: "delete", entity: "Supplier", entityId: s.id, summary: `删了供应商「${s.name}」` });
    刷新();
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
}

export type 比价输入 = {
  id?: string;
  opportunityId: string;
  /** 选了已有的供应商给 id；在抽屉里直接敲了个新名字给 supplierName，没有就顺手建一家 */
  supplierId?: string | null;
  supplierName?: string | null;
  product: string;
  unitPrice: number;
  currency?: string;
  withInvoice?: boolean;
  moq?: number | null;
  leadDays?: number | null;
  sampleFee?: number | null;
  validUntil?: string | null;
  verdict?: string;
  reason?: string | null;
};

export async function saveSupplierQuote(input: 比价输入) {
  try {
    const me = await requireUser();
    const 商机 = await prisma.opportunity.findUnique({ where: { id: String(input.opportunityId ?? "") }, select: { id: true, name: true, customerId: true } });
    if (!商机) return { ok: false as const, error: "这个商机已经不在了" };
    const product = 文本(input.product, 120);
    if (!product) return { ok: false as const, error: "请写产品" };
    const 价 = 非负(input.unitPrice);
    if (价 === "坏" || 价 === null) return { ok: false as const, error: "出厂价要是一个不小于 0 的数" };
    const 别的数: Record<string, number | null> = {};
    for (const [k, 名] of [["moq", "MOQ"], ["leadDays", "交期"], ["sampleFee", "打样费"]] as const) {
      const n = 非负(input[k]);
      if (n === "坏") return { ok: false as const, error: `${名}要是一个不小于 0 的数` };
      别的数[k] = k === "leadDays" && n !== null ? Math.round(n) : n;
    }
    if (input.currency && !是币种(String(input.currency).toUpperCase())) return { ok: false as const, error: "不认识这个币种" };
    const verdict = input.verdict ?? "待定";
    if (!(结论们 as readonly string[]).includes(verdict)) return { ok: false as const, error: `结论只能是：${结论们.join(" / ")}` };
    const reason = 可空文本(input.reason, 500);
    if (要理由.includes(verdict) && !reason) return { ok: false as const, error: `「${verdict}」要写一句理由` };
    let validUntil: Date | null = null;
    if (input.validUntil) {
      validUntil = new Date(input.validUntil);
      if (Number.isNaN(validUntil.getTime())) return { ok: false as const, error: "有效期不是一个日期" };
    }

    // 供应商：给了 id 用它；只给了名字，有同名的用那一家，没有就建一家（抽屉里录比价时不必先去建档）
    let supplierId = input.supplierId || null;
    if (supplierId && !(await prisma.supplier.findUnique({ where: { id: supplierId }, select: { id: true } }))) return { ok: false as const, error: "这家供应商已经不在了" };
    if (!supplierId) {
      const 名 = 文本(input.supplierName, 60);
      if (!名) return { ok: false as const, error: "请选一家供应商，或写个名字" };
      supplierId = (await prisma.supplier.findFirst({ where: { name: 名 }, select: { id: true } }))?.id ?? (await prisma.supplier.create({ data: { name: 名 } })).id;
    }

    const data = {
      opportunityId: 商机.id, supplierId, product, unitPrice: Math.round(价 * 10000) / 10000,
      currency: 规整币种(input.currency ?? "CNY"), withInvoice: !!input.withInvoice,
      moq: 别的数.moq, leadDays: 别的数.leadDays, sampleFee: 别的数.sampleFee, validUntil, verdict, reason,
    };
    const q = input.id ? await prisma.supplierQuote.update({ where: { id: input.id }, data, include: { supplier: { select: { name: true } } } }) : await prisma.supplierQuote.create({ data, include: { supplier: { select: { name: true } } } });
    await recordAudit({
      user: me, action: input.id ? "update" : "create", entity: "Opportunity", entityId: 商机.id,
      summary: `商机「${商机.name}」比价：${q.supplier.name} · ${product} ${显示金额(q.unitPrice, q.currency)}${q.withInvoice ? "（含票）" : ""} · ${verdict}${reason ? `（${reason}）` : ""}`,
    });
    刷新(supplierId);
    revalidatePath(`/customers/${商机.customerId}`);
    return { ok: true as const, id: q.id };
  } catch (e) {
    return 不在了(e);
  }
}

export async function deleteSupplierQuote(id: string) {
  try {
    const me = await requireUser();
    const q = await prisma.supplierQuote.findUnique({ where: { id: String(id ?? "") }, include: { supplier: { select: { name: true } }, opportunity: { select: { name: true } } } });
    if (!q) return { ok: true as const };
    await prisma.supplierQuote.delete({ where: { id: q.id } });
    await recordAudit({ user: me, action: "update", entity: "Opportunity", entityId: q.opportunityId, summary: `商机「${q.opportunity.name}」删了一行比价：${q.supplier.name} · ${q.product}` });
    刷新(q.supplierId);
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
}

/** 比价抽屉要的：这个商机的比价行、供应商候选、商机当前报价里的产品（录比价时下拉选） */
export async function 读比价(opportunityId: string) {
  await requireUser();
  const id = String(opportunityId ?? "");
  const [行, 供应商, 报价] = await Promise.all([
    prisma.supplierQuote.findMany({ where: { opportunityId: id }, orderBy: [{ product: "asc" }, { unitPrice: "asc" }], include: { supplier: { select: { id: true, name: true, rating: true, issues: true } } } }),
    prisma.supplier.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, rating: true, issues: true }, take: 500 }),
    prisma.quote.findFirst({ where: { opportunityId: id }, orderBy: [{ quotedAt: "desc" }, { id: "desc" }], select: { lines: { orderBy: { sort: "asc" }, select: { product: true } } } }),
  ]);
  return {
    行: 行.map((r) => ({ ...r, validUntil: r.validUntil?.toISOString() ?? null, quotedAt: r.quotedAt.toISOString() })),
    供应商,
    产品: [...new Set((报价?.lines ?? []).map((l) => l.product))],
  };
}
