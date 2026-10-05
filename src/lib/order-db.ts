/**
 * 外贸订单的读（2026-10-03 外贸第 3a 块）。写在 app/(app)/orders/actions.ts，规则在 lib/order.ts。
 */
import type { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import { 当前节点, 超期数, 进度, 订单的钱 } from "./order";
import { 规整币种 } from "./currency";
import { 签约币种, 签约金额 } from "./money-db";

const 节点查询 = { orderBy: { idx: "asc" as const }, select: { idx: true, name: true, dueAt: true, status: true, doneAt: true } };

type 节点行 = { idx: number; name: string; dueAt: Date | null; status: string; doneAt: Date | null };
const 节点出 = (n: 节点行) => ({ idx: n.idx, name: n.name, dueAt: n.dueAt?.toISOString() ?? null, status: n.status, doneAt: n.doneAt?.toISOString() ?? null });

export type 订单行 = {
  id: string;
  no: string;
  customerId: string;
  customerName: string;
  ownerId: string;
  ownerName: string;
  amount: number;
  currency: string;
  incoterm: string | null;
  /** 付款方式、供应商、订单确认时间（2026-10-05 外贸客户要的列）。确认时间 = 那笔签约的时间，老订单没有签约就用建单时间 */
  payment: string | null;
  supplier: string | null;
  confirmedAt: string;
  createdAt: string;
  nodes: ReturnType<typeof 节点出>[];
  当前: { idx: number; name: string } | null;
  超期: number;
  进度: number;
  未收: number;
};

/** 订单一览：每行一单，带 12 个节点。超期多的排上面，其次新的在前（和 Excel 总表同一个看法） */
export async function 订单列表(where: Prisma.TradeOrderWhereInput = {}, 现在: Date = new Date()): Promise<订单行[]> {
  const rows = await prisma.tradeOrder.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 500,
    include: {
      customer: { select: { name: true } },
      nodes: 节点查询,
      contract: { select: { signedAt: true } },
      purchase: { select: { supplier: { select: { name: true } } } },
    },
  });
  const 人 = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.ownerId))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return rows
    .map((o) => {
      const nodes = o.nodes.map(节点出);
      const 当 = 当前节点(nodes);
      return {
        id: o.id,
        no: o.no,
        customerId: o.customerId,
        customerName: o.customer.name,
        ownerId: o.ownerId,
        ownerName: 人.get(o.ownerId) ?? "（已删除的成员）",
        amount: o.amount,
        currency: 规整币种(o.currency),
        incoterm: o.incoterm,
        payment: o.payment,
        supplier: o.purchase?.supplier?.name ?? null,
        confirmedAt: (o.contract?.signedAt ?? o.createdAt).toISOString(),
        createdAt: o.createdAt.toISOString(),
        nodes,
        当前: 当 ? { idx: 当.idx, name: 当.name } : null,
        超期: 超期数(nodes, 现在),
        进度: 进度(nodes),
        未收: 订单的钱(o).未收,
      };
    })
    .sort((a, b) => b.超期 - a.超期 || b.createdAt.localeCompare(a.createdAt));
}

/** 订单详情：表头、节点、单据、挂在各节点上的跟进、来源商机和它当前那一版报价 */
export async function 订单详情(id: string) {
  const o = await prisma.tradeOrder.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, name: true } },
      opportunity: {
        select: {
          id: true, name: true,
          quotes: { orderBy: [{ quotedAt: "desc" }, { id: "desc" }], take: 1, select: { quotedAt: true, currency: true, lines: { orderBy: { sort: "asc" }, select: { product: true, spec: true, qty: true, unit: true, unitPrice: true } } } },
        },
      },
      nodes: 节点查询,
      docs: { orderBy: { sort: "asc" }, select: { id: true, name: true, state: true } },
      followUps: { include: { followUp: { select: { id: true, content: true, occurredAt: true, owner: { select: { name: true } } } } } },
      purchase: { include: { supplier: { select: { id: true, name: true } } } },
      contract: { select: { id: true, amount: true, signedAt: true, remark: true, money: true } },
    },
  });
  if (!o) return null;
  const 业务员 = await prisma.user.findUnique({ where: { id: o.ownerId }, select: { name: true } });
  const q = o.opportunity?.quotes[0];
  return {
    id: o.id,
    no: o.no,
    customer: o.customer,
    opportunity: o.opportunity ? { id: o.opportunity.id, name: o.opportunity.name } : null,
    报价: q && q.lines.length ? { quotedAt: q.quotedAt.toISOString(), currency: 规整币种(q.currency), 行: q.lines } : null,
    ownerName: 业务员?.name ?? "（已删除的成员）",
    amount: o.amount,
    currency: 规整币种(o.currency),
    incoterm: o.incoterm,
    payment: o.payment,
    depositDue: o.depositDue,
    depositPaid: o.depositPaid,
    depositAt: o.depositAt?.toISOString() ?? null,
    balancePaid: o.balancePaid,
    balanceAt: o.balanceAt?.toISOString() ?? null,
    remark: o.remark,
    createdAt: o.createdAt.toISOString(),
    /** 这张订单对应的签约（外贸，2026-10-05）。金额、币种、确认时间、备注以它为准；老订单没有 */
    contract: o.contract
      ? { id: o.contract.id, amount: 签约金额(o.contract), currency: 签约币种(o.contract), signedAt: o.contract.signedAt.toISOString(), remark: o.contract.remark }
      : null,
    采购: o.purchase
      ? { supplierId: o.purchase.supplierId, supplierName: o.purchase.supplier?.name ?? null, cost: o.purchase.cost, currency: 规整币种(o.purchase.currency), fxRate: o.purchase.fxRate }
      : null,
    nodes: o.nodes.map(节点出),
    docs: o.docs,
    notes: o.followUps
      .map((x) => ({ nodeIdx: x.nodeIdx, id: x.followUp.id, content: x.followUp.content, occurredAt: x.followUp.occurredAt.toISOString(), who: x.followUp.owner.name }))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
  };
}

export type 订单详情数据 = NonNullable<Awaited<ReturnType<typeof 订单详情>>>;
