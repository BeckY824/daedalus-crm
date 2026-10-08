import { prisma } from "@/lib/prisma";
import type { 提醒项, 订单提醒项 } from "@/lib/reminders";

/**
 * 某人名下还没做的跟进计划和待办，摊成 算提醒() 要的样子。
 *
 * **Dock 上的数、左栏「跟进」上的数、手机顶栏铃铛上的数都从这里来**——同一个人、同一份查询、同一个 算提醒()。
 * 三处原来各算各的（铃铛数的是全部没做完的待办，Dock 数的是逾期 + 今天的计划和待办），
 * 人在 Dock 上看见 1、打开应用找不到那个 1 在哪儿（2026-09-29 用户报的）。
 */
export async function 取提醒项(ownerId: string): Promise<提醒项[]> {
  const [plans, tasks] = await Promise.all([
    prisma.followPlan.findMany({
      where: { done: false, ownerId },
      select: { id: true, subject: true, plannedAt: true, plannedOn: true, plannedHasTime: true, method: true, customer: { select: { id: true, name: true } } },
    }),
    prisma.task.findMany({
      where: { done: false, ownerId },
      select: { id: true, title: true, dueAt: true, dueOn: true, dueHasTime: true, customer: { select: { id: true, name: true } } },
    }),
  ]);
  return [
    ...plans.map((p) => ({ id: p.id, kind: "plan" as const, 标题: p.subject, 时间: p.plannedAt, 日历日: p.plannedOn, 明确钟点: p.plannedHasTime, customerId: p.customer.id, 客户: p.customer.name, 方式: p.method })),
    ...tasks.map((t) => ({ id: t.id, kind: "task" as const, 标题: t.title, 时间: t.dueAt, 日历日: t.dueOn, 明确钟点: t.dueHasTime, customerId: t.customer.id, 客户: t.customer.name })),
  ];
}

/**
 * 某人（业务员）名下订单里要看的节点：没完成、不是不适用，排了截止日或者卡住了。
 * 没有订单（通用模版）就是空的，什么都不多算。
 */
export async function 取订单提醒项(ownerId: string): Promise<订单提醒项[]> {
  const nodes = await prisma.tradeOrderNode.findMany({
    where: {
      status: { notIn: ["已完成", "不适用"] },
      OR: [{ dueAt: { not: null } }, { status: "卡住" }],
      // 跟客户现在的负责人走（二审）：order.ownerId 是下单那一刻固化的业绩归属，客户转给同事之后原业务员还在收提醒、点进去看不到
      order: { customer: { salesOwnerId: ownerId } },
    },
    select: { name: true, dueAt: true, status: true, order: { select: { id: true, no: true } } },
  });
  return nodes.map((n) => ({ orderId: n.order.id, no: n.order.no, 节点: n.name, 时间: n.dueAt, 卡住: n.status === "卡住" }));
}
