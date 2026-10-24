import type { PrismaClient } from "@/generated/prisma";
import { scheduleValue, scheduleOrder } from "@/lib/schedule-date";

/**
 * 首页「近期跟进任务」那张卡：未完成的任务 + 跟进计划按时间合并，取最近几条。
 *
 * 原来两张表的未完成行连标题、客户名全取回来再排（企业版 1 万计划 + 5 千任务，连客户那层要一百多毫秒）。
 * 现在先只取 id 和时间排出前几名，再按 id 取这几条的标题和客户。
 * 排序是全序（时间相同按 id），所以结果和全取回来排的一样；第二步取的时候有一条不见了（刚被删、刚完成），
 * 就整段退回全取，不拿半截结果。tests/dashboard-todo.test.ts 拿 全取待办 对拍。
 */

export type 待办条 = {
  id: string;
  title: string;
  customerId: string;
  customerName: string;
  dueAt: string | null;
  kind: "任务" | "计划";
};

type 库 = Pick<PrismaClient, "task" | "followPlan">;

/** 时间早的在前，没排时间的在最后；同一时刻按 id */
const 先后 = (a: { id: string; dueAt: string | null }, b: { id: string; dueAt: string | null }) =>
  scheduleOrder(a.dueAt) - scheduleOrder(b.dueAt) || a.id.localeCompare(b.id);

const 任务序 = { dueAt: { sort: "asc", nulls: "last" } } as const;
const 计划序 = { plannedAt: "asc" } as const;

/** 原来的取法：全取回来排。第二步对不上时退回它，测试拿它当基准 */
export async function 全取待办(db: 库, 条数 = 5): Promise<待办条[]> {
  const [tasks, plans] = await Promise.all([
    db.task.findMany({
      where: { done: false },
      orderBy: 任务序,
      select: { id: true, title: true, dueAt: true, dueOn: true, customer: { select: { id: true, name: true } } },
    }),
    db.followPlan.findMany({
      where: { done: false },
      orderBy: 计划序,
      select: { id: true, subject: true, plannedAt: true, plannedOn: true, customer: { select: { id: true, name: true } } },
    }),
  ]);
  return [
    ...tasks.map((t) => ({
      id: `task:${t.id}`,
      title: t.title,
      customerId: t.customer.id,
      customerName: t.customer.name,
      dueAt: scheduleValue(t.dueAt, t.dueOn),
      kind: "任务" as const,
    })),
    ...plans.map((p) => ({
      id: `plan:${p.id}`,
      title: p.subject,
      customerId: p.customer.id,
      customerName: p.customer.name,
      dueAt: scheduleValue(p.plannedAt, p.plannedOn)!,
      kind: "计划" as const,
    })),
  ]
    .sort(先后)
    .slice(0, 条数);
}

export async function 近期待办(db: 库, 条数 = 5): Promise<待办条[]> {
  const [tasks, plans] = await Promise.all([
    db.task.findMany({ where: { done: false }, orderBy: 任务序, select: { id: true, dueAt: true, dueOn: true } }),
    db.followPlan.findMany({ where: { done: false }, orderBy: 计划序, select: { id: true, plannedAt: true, plannedOn: true } }),
  ]);
  const 前几 = [
    ...tasks.map((t) => ({ id: `task:${t.id}`, 原: t.id, dueAt: scheduleValue(t.dueAt, t.dueOn), kind: "任务" as const })),
    ...plans.map((p) => ({ id: `plan:${p.id}`, 原: p.id, dueAt: scheduleValue(p.plannedAt, p.plannedOn)!, kind: "计划" as const })),
  ]
    .sort(先后)
    .slice(0, 条数);
  const 任务们 = 前几.filter((x) => x.kind === "任务").map((x) => x.原);
  const 计划们 = 前几.filter((x) => x.kind === "计划").map((x) => x.原);
  const [任务详, 计划详] = await Promise.all([
    任务们.length
      ? db.task.findMany({ where: { id: { in: 任务们 }, done: false }, select: { id: true, title: true, dueAt: true, dueOn: true, customer: { select: { id: true, name: true } } } })
      : [],
    计划们.length
      ? db.followPlan.findMany({ where: { id: { in: 计划们 }, done: false }, select: { id: true, subject: true, plannedAt: true, plannedOn: true, customer: { select: { id: true, name: true } } } })
      : [],
  ]);
  const 任务表 = new Map(任务详.map((t) => [t.id, t]));
  const 计划表 = new Map(计划详.map((p) => [p.id, p]));
  const out: 待办条[] = [];
  for (const x of 前几) {
    if (x.kind === "任务") {
      const t = 任务表.get(x.原);
      // 两步之间被删、被完成或改了时间：排出来的前几名不作数，整段退回全取
      if (!t || scheduleValue(t.dueAt, t.dueOn) !== x.dueAt) return 全取待办(db, 条数);
      out.push({ id: x.id, title: t.title, customerId: t.customer.id, customerName: t.customer.name, dueAt: x.dueAt, kind: x.kind });
    } else {
      const p = 计划表.get(x.原);
      if (!p || scheduleValue(p.plannedAt, p.plannedOn) !== x.dueAt) return 全取待办(db, 条数);
      out.push({ id: x.id, title: p.subject, customerId: p.customer.id, customerName: p.customer.name, dueAt: x.dueAt, kind: x.kind });
    }
  }
  return out;
}
