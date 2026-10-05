/**
 * 订单就是一笔签约（2026-10-05，外贸客户建议）。
 *
 * 客户原话：「把客户详情里面的签约名称改成订单，签约里面的信息对应成订单类目信息」。
 * 外贸里签约 = 客户确认 PI = 下单，签约和订单分开登记就是同一件事记两遍。所以外贸模版下：
 *   - 「新建订单」走登记签约那条原路（查重、赢单联动、把客户推到已签约、业绩都在那里），
 *     同一个事务里再写这张订单：订单号、付款方式、供应商
 *   - 金额、币种、订单确认时间以签约为准（确认时间 = 签约时间），订单上那两格只是跟着抄一份给订单一览用
 *   - 删签约订单跟着没（TradeOrder.contractId 外键级联）
 * 这里只写订单这一半；签约那一半在 customers/actions.ts 的 saveContract。
 */
import type { Prisma } from "@/generated/prisma";
import { 节点名们, 成交前节点数, 默认单据, 默认订单号 } from "./order";

/** 订单比签约多的那几格。不给（undefined）= 不碰 */
export type 订单附加 = {
  no?: string | null;
  payment?: string | null;
  /** 供应商名字：库里有同名的就挂上它，没有就新建一家（能选也能填）。空 = 不挂 */
  supplier?: string | null;
};

const 文本 = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** 名字 → 供应商 id。同名（去掉首尾空格后一字不差）的用旧的，不重复建 */
async function 供应商id(tx: Prisma.TransactionClient, 名: string): Promise<string | null> {
  if (!名) return null;
  const 有 = await tx.supplier.findFirst({ where: { name: 名 }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (有) return 有.id;
  return (await tx.supplier.create({ data: { name: 名 }, select: { id: true } })).id;
}

/**
 * 在登记 / 编辑签约的事务里把订单写上：这笔签约还没有订单就建一张，有就改。
 * 新建时：订单号不填按日期编（团队里带上下单人的第一个字）；从商机来的，前四个节点（询盘 → 客户确认）记成已完成。
 */
export async function 写签约的订单(
  tx: Prisma.TransactionClient,
  a: {
    签约id: string;
    customerId: string;
    ownerId: string;
    amount: number;
    currency: string;
    附加: 订单附加;
    /** 从哪个商机转来的（只认一个：勾了好几个商机就不挂） */
    opportunityId?: string | null;
    /** 团队里订单号的前缀（lib/order.ts 团队订单前缀） */
    前缀?: string;
    现在?: Date;
  },
): Promise<{ id: string; no: string }> {
  const 现在 = a.现在 ?? new Date();
  const 填的号 = a.附加.no !== undefined ? 文本(a.附加.no, 40) : undefined;
  const payment = a.附加.payment !== undefined ? 文本(a.附加.payment, 60) || null : undefined;
  const 供应商 = a.附加.supplier !== undefined ? await 供应商id(tx, 文本(a.附加.supplier, 80)) : undefined;

  const 已有 = await tx.tradeOrder.findUnique({ where: { contractId: a.签约id }, select: { id: true, no: true } });
  let o: { id: string; no: string };
  if (已有) {
    o = await tx.tradeOrder.update({
      where: { id: 已有.id },
      data: {
        amount: a.amount,
        currency: a.currency,
        ...(填的号 ? { no: 填的号 } : {}),
        ...(payment !== undefined ? { payment } : {}),
      },
      select: { id: true, no: true },
    });
  } else {
    const 日 = `${a.前缀 ?? ""}${现在.getFullYear()}${String(现在.getMonth() + 1).padStart(2, "0")}${String(现在.getDate()).padStart(2, "0")}`;
    const 今天的号 = 填的号 ? [] : (await tx.tradeOrder.findMany({ where: { no: { startsWith: 日 } }, select: { no: true } })).map((x) => x.no);
    const 从商机 = !!a.opportunityId;
    o = await tx.tradeOrder.create({
      data: {
        no: 填的号 || 默认订单号(今天的号, 现在, a.前缀 ?? ""),
        customerId: a.customerId,
        opportunityId: a.opportunityId ?? null,
        ownerId: a.ownerId,
        amount: a.amount,
        currency: a.currency,
        payment: payment ?? null,
        contractId: a.签约id,
        // 节点、单据这一版不摆（lib/features.ts 订单节点），照旧建上：哪天打开时老订单不至于一步都没有
        nodes: {
          create: 节点名们.map((name, i) => {
            const 走完 = 从商机 && i < 成交前节点数;
            return { idx: i + 1, name, status: 走完 ? "已完成" : "未开始", doneAt: 走完 ? 现在 : null };
          }),
        },
        docs: { create: 默认单据(null).map((name, i) => ({ name, sort: i })) },
      },
      select: { id: true, no: true },
    });
  }
  if (供应商 !== undefined) {
    if (供应商) await tx.tradeOrderPurchase.upsert({ where: { orderId: o.id }, create: { orderId: o.id, supplierId: 供应商 }, update: { supplierId: 供应商 } });
    else await tx.tradeOrderPurchase.updateMany({ where: { orderId: o.id }, data: { supplierId: null } });
  }
  return o;
}
