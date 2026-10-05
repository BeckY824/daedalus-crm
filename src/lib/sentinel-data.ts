/**
 * 盯盘清单的取数：从库里捞出三类原料，交给 sentinel.ts 的纯规则打分。
 * 首页（AI 对话的建议 chip）和数据看板（盯盘卡片）共用，避免两处各写一遍查询。
 */
import { 订单节点 } from "@/lib/features";
import { 今天零点 } from "./overdue";
import { prisma } from "./prisma";
import { dayjs } from "./utils";
import { buildWatchlist, type WatchItem } from "./sentinel";
import { getBusiness } from "./business";
import { statusLabel, stageLabel } from "./business-config";

/**
 * `范围.ownerId` 给了就只看这个人名下的，**先筛再排前 8**（排查 C7）：
 * 原来首页先取全团队前 8 位、再按姓名筛出「我的」，我的那几位排不进全团队前 8 就数漏了，重名的还会混在一起。
 */
export async function loadWatchlist(now = dayjs(), 范围: { ownerId?: string } = {}): Promise<WatchItem[]> {
  const 谁的 = 范围.ownerId;
  const [overduePlans, customers, opps, lateNodes, business] = await Promise.all([
    prisma.followPlan.findMany({
      // 逾期按今天零点算，和首页、左栏角标、计划页一个口径（lib/overdue.ts）：今天上午没做的还算今天的
      where: { done: false, plannedAt: { lt: 今天零点(now.toDate()) }, ...(谁的 ? { ownerId: 谁的 } : {}) },
      select: { subject: true, plannedAt: true, customer: { select: { id: true, name: true } }, owner: { select: { name: true } } },
    }),
    prisma.customer.findMany({
      where: { followStatus: { notIn: ["已签约", "已流失", "暂缓跟进"] }, ...(谁的 ? { salesOwnerId: 谁的 } : {}) },
      select: { id: true, name: true, followStatus: true, lastFollowAt: true, createdAt: true, salesOwner: { select: { name: true } } },
    }),
    prisma.opportunity.findMany({
      where: { status: "OPEN", ...(谁的 ? { ownerId: 谁的 } : {}) },
      select: { name: true, stage: true, updatedAt: true, customer: { select: { id: true, name: true } }, owner: { select: { name: true } } },
    }),
    // 订单里超期 / 卡住的节点：截止日早于今天零点（和订单一览的红格同一个口径，lib/order.ts 节点灯）。
    // 订单节点这一版不上（lib/features.ts）就不取：盯盘里不出订单
    !订单节点 ? Promise.resolve([]) : prisma.tradeOrderNode.findMany({
      where: {
        status: { notIn: ["已完成", "不适用"] },
        OR: [{ status: "卡住" }, { dueAt: { lt: 今天零点(now.toDate()) } }],
        // 同 取订单提醒项：按客户现在的负责人，不按下单时固化的业绩归属
        ...(谁的 ? { order: { customer: { salesOwnerId: 谁的 } } } : {}),
      },
      select: { idx: true, name: true, dueAt: true, status: true, order: { select: { id: true, no: true, ownerId: true, customer: { select: { id: true, name: true } } } } },
    }),
    getBusiness(),
  ]);
  const 业务员 = new Map(
    (await prisma.user.findMany({ where: { id: { in: [...new Set(lateNodes.map((x) => x.order.ownerId))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
  );
  return buildWatchlist(
    {
      overduePlans: overduePlans.map((p) => ({ customerId: p.customer.id, customerName: p.customer.name, ownerName: p.owner.name, subject: p.subject, plannedAt: p.plannedAt })),
      customers: customers.map((c) => ({ id: c.id, name: c.name, followStatus: c.followStatus, lastFollowAt: c.lastFollowAt, createdAt: c.createdAt, ownerName: c.salesOwner.name })),
      opportunities: opps.map((o) => ({ customerId: o.customer.id, customerName: o.customer.name, ownerName: o.owner.name, name: o.name, stage: stageLabel(business, o.stage), updatedAt: o.updatedAt })),
      lateOrderNodes: lateNodes.map((x) => ({
        orderId: x.order.id, orderNo: x.order.no, idx: x.idx, nodeName: x.name, dueAt: x.dueAt, 卡住: x.status === "卡住",
        customerId: x.order.customer.id, customerName: x.order.customer.name, ownerName: 业务员.get(x.order.ownerId) ?? "",
      })),
    },
    now.toDate(),
    business.customer,
    (v) => statusLabel(business, v),
  );
}
