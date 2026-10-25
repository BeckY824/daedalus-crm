import type { PrismaClient } from "@/generated/prisma";
import { scheduleValue, scheduleOrder, isCalendarDate } from "@/lib/schedule-date";

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

/**
 * 时间早的在前，没排时间的在最后；同一时刻按 id。
 * 原来是 `.sort((a, b) => scheduleOrder(a.dueAt) - scheduleOrder(b.dueAt) || a.id.localeCompare(b.id))`，
 * 每比一次就把两边的日期串各解析一遍，企业版 1.5 万条未完成时首页光这一步要一秒多（2026-10-24 CPU 分析）。
 * 现在每行只解析一次；比较时用的数和原来完全一样（同一个 scheduleOrder），sort 又是稳定的，所以次序也一样。
 * tests/dashboard-todo.test.ts 拿原来的比较函数对拍
 */
export function 按先后排<T extends { id: string; dueAt: string | null }>(行: T[]): T[] {
  return 行
    .map((x) => ({ x, k: scheduleOrder(x.dueAt) }))
    .sort((a, b) => a.k - b.k || a.x.id.localeCompare(b.x.id))
    .map((a) => a.x);
}

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
  return 按先后排([
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
  ]).slice(0, 条数);
}

/**
 * 和 scheduleOrder(scheduleValue(at, on)) 一样的数，但几千行时不必每行都走一遍日期解析（2026-10-25 企业版压测：首页 CPU 两成在这）：
 * 只排日期的按日期串记一次（同一天的成百上千条只解析一回）；带钟点的 scheduleValue 是 toISOString，
 * 4 位年份的 ISO 串解析回来就是原来那个毫秒数，直接用 getTime；年份出了 1–9999 照原样走一遍。
 */
export function 排序键(): (at: Date | null, on: string | null) => number {
  const 日期键 = new Map<string, number | null>();
  return (at, on) => {
    if (on) {
      let k = 日期键.get(on);
      if (k === undefined) 日期键.set(on, (k = isCalendarDate(on) ? scheduleOrder(on) : null));
      if (k !== null) return k;
    }
    if (!at) return Infinity;
    const y = at.getUTCFullYear();
    return y >= 1 && y <= 9999 ? at.getTime() : scheduleOrder(scheduleValue(at, null));
  };
}

/**
 * 按 按先后排 的次序取前 n 条，不排全部：一遍扫过去只留前 n 名（n 是首页那 5 条）。
 * 比较和 按先后排 是同一个；后来的和前面的一样大时排在它后面，等于稳定排序，所以和 按先后排(行).slice(0, n) 一模一样
 */
export function 前几名<T extends { id: string; k: number }>(行: readonly T[], n: number): T[] {
  const 比 = (a: T, b: T) => a.k - b.k || a.id.localeCompare(b.id);
  if (n * 8 >= 行.length) return [...行].sort(比).slice(0, n);
  const 留: T[] = [];
  if (n <= 0) return 留;
  for (const x of 行) {
    if (留.length === n && 比(留[n - 1], x) <= 0) continue;
    let i = 留.length;
    while (i > 0 && 比(留[i - 1], x) > 0) i--;
    留.splice(i, 0, x);
    if (留.length > n) 留.pop();
  }
  return 留;
}

export async function 近期待办(db: 库, 条数 = 5): Promise<待办条[]> {
  const [tasks, plans] = await Promise.all([
    db.task.findMany({ where: { done: false }, orderBy: 任务序, select: { id: true, dueAt: true, dueOn: true } }),
    db.followPlan.findMany({ where: { done: false }, orderBy: 计划序, select: { id: true, plannedAt: true, plannedOn: true } }),
  ]);
  const 键 = 排序键();
  // 只给排进前几名的算 scheduleValue（toISOString），其余几千条只要一个数
  const 前几 = 前几名(
    [
      ...tasks.map((t) => ({ id: `task:${t.id}`, 原: t.id, at: t.dueAt, on: t.dueOn, k: 键(t.dueAt, t.dueOn), kind: "任务" as const })),
      ...plans.map((p) => ({ id: `plan:${p.id}`, 原: p.id, at: p.plannedAt, on: p.plannedOn, k: 键(p.plannedAt, p.plannedOn), kind: "计划" as const })),
    ],
    条数,
  ).map((x) => ({ id: x.id, 原: x.原, kind: x.kind, dueAt: scheduleValue(x.at, x.on) }));
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
