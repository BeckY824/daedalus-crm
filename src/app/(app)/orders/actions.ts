"use server";

import { businessDayjs } from "@/lib/business-clock";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { 不在了 } from "@/lib/not-there";
import { 是币种, 规整币种, 金额 as 显示金额 } from "@/lib/currency";
import { 商机币种, 带币种 } from "@/lib/money-db";
import { 节点名们, 节点状态们, 单据状态们, 默认单据, 默认订单号, 成交前节点数, 团队订单前缀 } from "@/lib/order";
import { 读团队 } from "@/lib/sync/client";
import { getBusiness } from "@/lib/business";
import { 订单, 订单节点, 供应商页 } from "@/lib/features";
import { 外贸订单 } from "@/lib/business-config";
import { saveFollowUp } from "../customers/[id]/actions";

/**
 * 外贸订单的写操作（2026-10-03 外贸第 3a 块）。规则在 lib/order.ts。
 * 每一样都留日志：订单是钱和交期，「谁哪天把定金改成已收」事后一定有人要问。
 */

function 刷新(订单id?: string, 客户id?: string) {
  revalidatePath("/orders");
  if (订单id) revalidatePath(`/orders/${订单id}`);
  if (客户id) revalidatePath(`/customers/${客户id}`);
}

const 文本 = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const 钱 = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1e12 ? Math.round(n * 100) / 100 : null;
};
const 日期 = (v: unknown): Date | null | "坏" => {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? "坏" : d;
};

export type 订单输入 = {
  no?: string;
  amount?: number;
  currency?: string;
  incoterm?: string | null;
  payment?: string | null;
  depositDue?: number;
  depositPaid?: number;
  depositAt?: string | null;
  balancePaid?: number;
  balanceAt?: string | null;
  remark?: string | null;
};

/** 整理表头那几格。给了才改，没给的不动；格式不对说清是哪一格 */
function 整理(input: 订单输入): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const data: Record<string, unknown> = {};
  if (input.no !== undefined) {
    const no = 文本(input.no, 40);
    if (!no) return { ok: false, error: "订单号不能空着" };
    data.no = no;
  }
  if (input.currency !== undefined) {
    if (!是币种(String(input.currency).toUpperCase())) return { ok: false, error: "不认识这个币种" };
    data.currency = 规整币种(input.currency);
  }
  for (const [k, 名] of [["amount", "订单金额"], ["depositDue", "定金应收"], ["depositPaid", "定金实收"], ["balancePaid", "尾款实收"]] as const) {
    if (input[k] === undefined) continue;
    const n = 钱(input[k]);
    if (n === null) return { ok: false, error: `${名}要是一个不小于 0 的数` };
    data[k] = n;
  }
  for (const [k, 名] of [["depositAt", "定金到账日"], ["balanceAt", "尾款到账日"]] as const) {
    if (input[k] === undefined) continue;
    const d = 日期(input[k]);
    if (d === "坏") return { ok: false, error: `${名}不是一个日期` };
    data[k] = d;
  }
  if (input.incoterm !== undefined) data.incoterm = 文本(input.incoterm, 10).toUpperCase() || null;
  if (input.payment !== undefined) data.payment = 文本(input.payment, 60) || null;
  if (input.remark !== undefined) data.remark = 文本(input.remark, 2000) || null;
  if (typeof data.amount === "number" && typeof data.depositDue === "number" && data.depositDue > data.amount) {
    return { ok: false, error: "定金比订单金额还多" };
  }
  return { ok: true, data };
}

/**
 * 新建订单。从赢单的商机来（opportunityId）：客户、金额、币种带过去，前四个节点（询盘 → 客户确认）记成已完成；
 * 这个商机已经有订单了就不再建第二张，把那一张的 id 还回去（连点两下、两个人各点一次都不会多出一单）。
 * 业务员 = 商机负责人，没有商机就是客户的销售负责人，下单那一刻固化。
 */
export async function createOrder(input: 订单输入 & { customerId: string; opportunityId?: string | null }) {
  try {
    const me = await requireUser();
    if (!订单 || !订单节点) return { ok: false as const, error: "此版本未开放订单节点与单据功能" };
    /*
      外贸模版下订单就是一笔签约（2026-10-05，lib/order-contract.ts）：只从「新建订单」/「转为订单」那个框建，
      这里直接建出来的单没有签约、不算业绩（复查）。别的模版不摆订单，留着给节点那一套（开关打开时）和老调用
    */
    if (外贸订单(await getBusiness())) return { ok: false as const, error: "订单请在客户页「新建订单」或商机「转为订单」里建" };
    const 客户 = await prisma.customer.findUnique({ where: { id: String(input.customerId ?? "") }, select: { id: true, name: true, salesOwnerId: true } });
    if (!客户) return { ok: false as const, error: "这位客户已经不在了" };
    const 商机 = input.opportunityId
      ? await prisma.opportunity.findUnique({ where: { id: input.opportunityId }, select: { id: true, name: true, customerId: true, ownerId: true, amount: true, ...带币种.商机 } })
      : null;
    if (input.opportunityId && (!商机 || 商机.customerId !== 客户.id)) return { ok: false as const, error: "这个商机已经不在了，或者不是这位客户的" };
    if (商机) {
      const 已有 = await prisma.tradeOrder.findFirst({ where: { opportunityId: 商机.id }, select: { id: true } });
      if (已有) return { ok: true as const, id: 已有.id, 已有: true };
    }
    const 今天 = new Date();
    // 开了团队同步：编号带上下单人的第一个字，几台电脑各编各的不会撞号
    const 前缀 = 读团队() ? 团队订单前缀(me.name) : "";
    const 日 = `${前缀}${businessDayjs(今天).format("YYYYMMDD")}`;
    const 今天的号 = (await prisma.tradeOrder.findMany({ where: { no: { startsWith: 日 } }, select: { no: true } })).map((x) => x.no);
    const 表头 = 整理({
      no: input.no || 默认订单号(今天的号, 今天, 前缀),
      amount: input.amount ?? 商机?.amount ?? 0,
      currency: input.currency ?? (商机 ? 商机币种(商机) : "USD"),
      ...(input.incoterm !== undefined ? { incoterm: input.incoterm } : {}),
      ...(input.payment !== undefined ? { payment: input.payment } : {}),
      ...(input.depositDue !== undefined ? { depositDue: input.depositDue } : {}),
      ...(input.remark !== undefined ? { remark: input.remark } : {}),
    });
    if (!表头.ok) return 表头;
    const incoterm = (表头.data.incoterm as string | null | undefined) ?? null;
    const o = await prisma.tradeOrder.create({
      data: {
        ...(表头.data as { no: string; amount: number; currency: string }),
        customerId: 客户.id,
        opportunityId: 商机?.id ?? null,
        ownerId: 商机?.ownerId ?? 客户.salesOwnerId,
        nodes: {
          create: 节点名们.map((name, i) => {
            const 走完 = !!商机 && i < 成交前节点数;
            return { idx: i + 1, name, status: 走完 ? "已完成" : "未开始", doneAt: 走完 ? 今天 : null };
          }),
        },
        docs: { create: 默认单据(incoterm).map((name, i) => ({ name, sort: i })) },
        /*
          比价里「选用」的那家带过去当这一单的供应商（3c）。只带供应商不带采购额：
          比价是单价，采购额要乘数量、可能还有几个产品，算错一个数比空着更糟——留给人填
        */
        ...(商机 ? await 选用的供应商(商机.id) : {}),
      },
    });
    await recordAudit({
      user: me, action: "create", entity: "TradeOrder", entityId: o.id,
      summary: `给「${客户.name}」建了订单 ${o.no}：${显示金额(o.amount, o.currency)}${商机 ? `（来自商机「${商机.name}」）` : ""}`,
      detail: { 订单号: o.no, 金额: o.amount, 币种: o.currency, 商机: 商机?.name ?? null },
    });
    刷新(o.id, 客户.id);
    return { ok: true as const, id: o.id };
  } catch (e) {
    return 不在了(e);
  }
}

async function 选用的供应商(商机id: string) {
  const 选 = await prisma.supplierQuote.findFirst({ where: { opportunityId: 商机id, verdict: "选用" }, orderBy: { quotedAt: "desc" }, select: { supplierId: true, currency: true } });
  return 选 ? { purchase: { create: { supplierId: 选.supplierId, currency: 选.currency } } } : {};
}

/**
 * 订单的采购（3c）：从哪家采、采购额、汇率。毛利由 lib/supplier.ts 的 毛利() 现算，不存。
 * 汇率只用在这一单的毛利上——全站合计照样不换汇。
 */
export async function saveOrderPurchase(orderId: string, input: { supplierId?: string | null; cost?: number; currency?: string; fxRate?: number | null }) {
  try {
    const me = await requireUser();
    if (!订单 || !供应商页) return { ok: false as const, error: "此版本未开放供应商采购管理" };
    const o = await prisma.tradeOrder.findUnique({ where: { id: String(orderId ?? "") }, select: { id: true, no: true, customerId: true } });
    if (!o) return { ok: false as const, error: "这张订单已经不在了" };
    const cost = 钱(input.cost ?? 0);
    if (cost === null) return { ok: false as const, error: "采购额要是一个不小于 0 的数" };
    if (input.currency && !是币种(String(input.currency).toUpperCase())) return { ok: false as const, error: "不认识这个币种" };
    let fxRate: number | null = null;
    if (input.fxRate !== null && input.fxRate !== undefined && String(input.fxRate) !== "") {
      fxRate = Number(input.fxRate);
      if (!Number.isFinite(fxRate) || fxRate <= 0 || fxRate > 1e6) return { ok: false as const, error: "汇率要是一个大于 0 的数" };
    }
    const supplierId = input.supplierId || null;
    if (supplierId && !(await prisma.supplier.findUnique({ where: { id: supplierId }, select: { id: true } }))) return { ok: false as const, error: "这家供应商已经不在了" };
    const data = { supplierId, cost, currency: 规整币种(input.currency ?? "CNY"), fxRate };
    await prisma.tradeOrderPurchase.upsert({ where: { orderId: o.id }, create: { orderId: o.id, ...data }, update: data });
    await recordAudit({ user: me, action: "update", entity: "TradeOrder", entityId: o.id, summary: `订单 ${o.no} 的采购：${显示金额(cost, data.currency)}${fxRate ? `，汇率 ${fxRate}` : ""}`, detail: data });
    刷新(o.id, o.customerId);
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
}

/** 改表头：订单号、金额、币种、条款、付款方式、定金 / 尾款、备注。只改给了的那几格 */
export async function saveOrder(id: string, input: 订单输入) {
  try {
    const me = await requireUser();
    if (!订单节点 && ["incoterm", "depositDue", "depositPaid", "depositAt", "balancePaid", "balanceAt"].some((k) => k in input)) return { ok: false as const, error: "此版本未开放订单条款与定金尾款管理" };
    if (!订单) return { ok: false as const, error: "此版本未开放订单功能" };
    const 原 = await prisma.tradeOrder.findUnique({ where: { id: String(id ?? "") }, select: { id: true, no: true, customerId: true, amount: true, depositDue: true, contractId: true } });
    if (!原) return { ok: false as const, error: "这张订单已经不在了" };
    // 有签约的订单：金额、币种跟着签约走（2026-10-05 复查），在订单框里改——这里改了两边就对不上
    if (原.contractId && (input.amount !== undefined || input.currency !== undefined)) {
      return { ok: false as const, error: "金额和币种在「编辑订单」里改，和这笔签约一起改" };
    }
    const r = 整理(input);
    if (!r.ok) return r;
    // 只在这次改了金额或定金时才比（二审：只存实收也被老的定金卡住）
    const 金额 = (r.data.amount as number | undefined) ?? 原.amount;
    const 定金 = (r.data.depositDue as number | undefined) ?? 原.depositDue;
    if (("amount" in r.data || "depositDue" in r.data) && 定金 > 金额) return { ok: false as const, error: "定金比订单金额还多" };
    const o = await prisma.tradeOrder.update({ where: { id: 原.id }, data: r.data });
    await recordAudit({
      user: me, action: "update", entity: "TradeOrder", entityId: o.id,
      summary: `改了订单 ${o.no}：${Object.keys(r.data).map((k) => 字段名[k] ?? k).join("、")}`,
      detail: r.data,
    });
    刷新(o.id, o.customerId);
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
}

const 字段名: Record<string, string> = {
  no: "订单号", amount: "金额", currency: "币种", incoterm: "贸易条款", payment: "付款方式",
  depositDue: "定金应收", depositPaid: "定金实收", depositAt: "定金到账日", balancePaid: "尾款实收", balanceAt: "尾款到账日", remark: "备注",
};

/** 改一个节点：名字、截止日、状态。改成已完成记下完成那一刻，改回别的就清掉 */
export async function saveOrderNode(orderId: string, idx: number, patch: { name?: string; dueAt?: string | null; status?: string }) {
  try {
    const me = await requireUser();
    if (!订单 || !订单节点) return { ok: false as const, error: "此版本未开放订单节点与单据功能" };
    const n = await prisma.tradeOrderNode.findUnique({ where: { orderId_idx: { orderId: String(orderId ?? ""), idx: Number(idx) } }, include: { order: { select: { no: true, customerId: true } } } });
    if (!n) return { ok: false as const, error: "这个节点已经不在了" };
    const data: { name?: string; dueAt?: Date | null; status?: string; doneAt?: Date | null } = {};
    if (patch.name !== undefined) {
      const name = 文本(patch.name, 30);
      if (!name) return { ok: false as const, error: "节点名不能空着" };
      data.name = name;
    }
    if (patch.dueAt !== undefined) {
      const d = 日期(patch.dueAt);
      if (d === "坏") return { ok: false as const, error: "截止日不是一个日期" };
      data.dueAt = d;
    }
    if (patch.status !== undefined) {
      if (!(节点状态们 as readonly string[]).includes(patch.status)) return { ok: false as const, error: `节点状态只能是：${节点状态们.join(" / ")}` };
      data.status = patch.status;
      if (patch.status !== n.status) data.doneAt = patch.status === "已完成" ? new Date() : null;
    }
    await prisma.tradeOrderNode.update({ where: { id: n.id }, data });
    const 说 = [
      data.name !== undefined && data.name !== n.name ? `改名为「${data.name}」` : "",
      data.status !== undefined && data.status !== n.status ? `${n.status} → ${data.status}` : "",
      data.dueAt !== undefined ? `截止日 ${data.dueAt ? data.dueAt.toISOString().slice(0, 10) : "清空"}` : "",
    ].filter(Boolean);
    if (说.length) {
      await recordAudit({
        user: me, action: "update", entity: "TradeOrder", entityId: orderId,
        summary: `订单 ${n.order.no} 第 ${n.idx} 步「${n.name}」：${说.join("，")}`,
        detail: { 节点: n.idx, ...data },
      });
    }
    刷新(orderId, n.order.customerId);
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
}

/** 单据：改状态、加一样、删一样 */
export async function saveOrderDoc(docId: string, state: string) {
  try {
    const me = await requireUser();
    if (!订单 || !订单节点) return { ok: false as const, error: "此版本未开放订单节点与单据功能" };
    if (!(单据状态们 as readonly string[]).includes(state)) return { ok: false as const, error: `单据状态只能是：${单据状态们.join(" / ")}` };
    const d = await prisma.tradeOrderDoc.findUnique({ where: { id: String(docId ?? "") }, include: { order: { select: { id: true, no: true, customerId: true } } } });
    if (!d) return { ok: false as const, error: "这样单据已经不在了" };
    if (d.state === state) return { ok: true as const };
    await prisma.tradeOrderDoc.update({ where: { id: d.id }, data: { state } });
    await recordAudit({ user: me, action: "update", entity: "TradeOrder", entityId: d.order.id, summary: `订单 ${d.order.no} 的「${d.name}」：${d.state} → ${state}` });
    刷新(d.order.id, d.order.customerId);
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
}

export async function addOrderDoc(orderId: string, name: string) {
  try {
    const me = await requireUser();
    if (!订单 || !订单节点) return { ok: false as const, error: "此版本未开放订单节点与单据功能" };
    const 名 = 文本(name, 60);
    if (!名) return { ok: false as const, error: "单据名不能空着" };
    const o = await prisma.tradeOrder.findUnique({ where: { id: String(orderId ?? "") }, select: { id: true, no: true, customerId: true, docs: { select: { sort: true, name: true } } } });
    if (!o) return { ok: false as const, error: "这张订单已经不在了" };
    if (o.docs.some((x) => x.name === 名)) return { ok: false as const, error: `已经有「${名}」了` };
    const d = await prisma.tradeOrderDoc.create({ data: { orderId: o.id, name: 名, sort: Math.max(-1, ...o.docs.map((x) => x.sort)) + 1 } });
    await recordAudit({ user: me, action: "update", entity: "TradeOrder", entityId: o.id, summary: `订单 ${o.no} 加了一样单据「${名}」` });
    刷新(o.id, o.customerId);
    return { ok: true as const, id: d.id };
  } catch (e) {
    return 不在了(e);
  }
}

export async function deleteOrderDoc(docId: string) {
  try {
    const me = await requireUser();
    if (!订单 || !订单节点) return { ok: false as const, error: "此版本未开放订单节点与单据功能" };
    const d = await prisma.tradeOrderDoc.findUnique({ where: { id: String(docId ?? "") }, include: { order: { select: { id: true, no: true, customerId: true } } } });
    if (!d) return { ok: true as const };
    await prisma.tradeOrderDoc.delete({ where: { id: d.id } });
    await recordAudit({ user: me, action: "update", entity: "TradeOrder", entityId: d.order.id, summary: `订单 ${d.order.no} 删了一样单据「${d.name}」` });
    刷新(d.order.id, d.order.customerId);
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
}

/**
 * 在某个节点上记一笔：走记跟进那条原本的路（客户的「最近跟进」、日志、时间线都照常），再挂到这个节点上。
 * 「每次问工厂的结果就是一条跟进」（外贸CRM模版.md 2.6）——节点上不另堆字段。
 */
export async function addOrderNodeNote(orderId: string, idx: number, content: string) {
  try {
    await requireUser();
    if (!订单 || !订单节点) return { ok: false as const, error: "此版本未开放订单节点与单据功能" };
    const 话 = 文本(content, 5000);
    if (!话) return { ok: false as const, error: "写点什么再记" };
    const n = await prisma.tradeOrderNode.findUnique({ where: { orderId_idx: { orderId: String(orderId ?? ""), idx: Number(idx) } }, include: { order: { select: { id: true, no: true, customerId: true, opportunityId: true } } } });
    if (!n) return { ok: false as const, error: "这个节点已经不在了" };
    const r = await saveFollowUp({
      customerId: n.order.customerId,
      type: "OTHER",
      title: `订单 ${n.order.no} · ${n.name}`,
      content: 话,
      status: "已完成",
      occurredAt: new Date().toISOString(),
      opportunityId: n.order.opportunityId,
    });
    if (!r.ok) return r;
    await prisma.followUpOrder.create({ data: { followUpId: r.id, orderId: n.order.id, nodeIdx: n.idx } });
    刷新(n.order.id, n.order.customerId);
    return { ok: true as const, id: r.id };
  } catch (e) {
    return 不在了(e);
  }
}

/**
 * 在订单上记一笔（2026-10-05，节点关着时的订单页）：走记跟进那条原路，再挂到这张订单上（nodeIdx 0 = 整单，不挂某一步）。
 * 外贸客户：「这样就可以对订单执行做跟进的记录了」
 */
export async function addOrderNote(orderId: string, content: string) {
  try {
    await requireUser();
    if (!订单) return { ok: false as const, error: "此版本未开放订单功能" };
    const 话 = 文本(content, 5000);
    if (!话) return { ok: false as const, error: "写点什么再记" };
    const o = await prisma.tradeOrder.findUnique({ where: { id: String(orderId ?? "") }, select: { id: true, no: true, customerId: true, opportunityId: true } });
    if (!o) return { ok: false as const, error: "这张订单已经不在了" };
    const r = await saveFollowUp({
      customerId: o.customerId,
      type: "OTHER",
      title: `订单 ${o.no}`,
      content: 话,
      status: "已完成",
      occurredAt: new Date().toISOString(),
      orderId: o.id,
    });
    if (!r.ok) return r;
    刷新(o.id, o.customerId);
    return { ok: true as const, id: r.id };
  } catch (e) {
    return 不在了(e);
  }
}

/** 订单框里「供应商」的候选：库里已有的供应商名字（去重，按名字排） */
export async function 供应商名单(): Promise<string[]> {
  await requireUser();
  const rows = await prisma.supplier.findMany({ orderBy: { name: "asc" }, take: 500, select: { name: true } });
  return [...new Set(rows.map((r) => r.name))];
}

/** 轻订单的候选包含稳定ID；同名档案仍分别可选，不需要开放供应商管理页。 */
export async function 供应商候选(): Promise<{ id: string; name: string }[]> {
  await requireUser();
  if (!订单) return [];
  return prisma.supplier.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }], take: 500, select: { id: true, name: true } });
}

/** 删订单。节点、单据跟着删；挂在节点上的跟进记录留着（那是和客户的往来，不是订单的附属品），只是不再挂在节点上 */
export async function deleteOrder(id: string) {
  try {
    const me = await requireUser();
    if (!订单) return { ok: false as const, error: "此版本未开放订单功能" };
    const o = await prisma.tradeOrder.findUnique({ where: { id: String(id ?? "") }, include: { customer: { select: { name: true } } } });
    if (!o) return { ok: true as const };
    // 有签约的订单在客户页删：删的是那笔签约，跟进状态要不要退回在那里问（2026-10-05 复查）
    if (o.contractId) return { ok: false as const, error: "这张订单在客户页的「订单」里删，会一起删掉这笔签约" };
    await prisma.tradeOrder.delete({ where: { id: o.id } });
    await recordAudit({
      user: me, action: "delete", entity: "TradeOrder", entityId: o.id,
      summary: `删了「${o.customer.name}」的订单 ${o.no}（${显示金额(o.amount, o.currency)}）`,
      detail: { 订单号: o.no, 金额: o.amount, 币种: o.currency },
    });
    刷新(undefined, o.customerId);
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
}
