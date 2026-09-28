import { prisma } from "@/lib/prisma";
import type { 提醒项 } from "@/lib/reminders";

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
      select: { id: true, subject: true, plannedAt: true, method: true, customer: { select: { id: true, name: true } } },
    }),
    prisma.task.findMany({
      where: { done: false, ownerId },
      select: { id: true, title: true, dueAt: true, customer: { select: { id: true, name: true } } },
    }),
  ]);
  return [
    ...plans.map((p) => ({ id: p.id, kind: "plan" as const, 标题: p.subject, 时间: p.plannedAt, customerId: p.customer.id, 客户: p.customer.name, 方式: p.method })),
    ...tasks.map((t) => ({ id: t.id, kind: "task" as const, 标题: t.title, 时间: t.dueAt, customerId: t.customer.id, 客户: t.customer.name })),
  ];
}
