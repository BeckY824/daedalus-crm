/**
 * 「逾期跟进」只有这一个口径：**跟进计划 + 待办，都算**（2026-09-28 产品拍板）。
 *
 * 为什么单拎一个文件：这个数在三个页面上出现——
 *   首页那一行信号（我的）       dashboard/page.tsx
 *   跟进计划页的「逾期」一组       follow-ups/plans/PlansView.tsx
 *   数据页的「逾期跟进」卡（全团队） dashboard/Board.tsx
 * 原来各写各的：首页只数了计划，另外两处计划和待办都数。于是首页写「4 · 先处理」，
 * 点进去是「逾期 6」——人会怀疑自己看错了，或者数据有问题。
 * 三处现在都从这里取，tests/overdue.test.ts 钉着「三处都引这个文件、而且数出来一样」。
 *
 * **「今天」按本地日历天**：逾期 = 时间早于今天零点、还没做完。
 * 和 lib/reminders.ts（Dock 上那个数）、PlansView 的分组、smartTime 同一个口径——
 * 桌面端本地服务和人在同一台电脑上，托管版容器 TZ=Asia/Shanghai（docs/部署.md）。
 * 别和 lib/tenant/credits.ts 的「今天」搞混：那边每日赠送按北京时间，是为了防跨时区一天领两次，
 * 说的是另一件事。
 *
 * 纯函数和一个注入库的计数函数放在一起，不 import prisma：PlansView 是客户端组件，也要用 是逾期()。
 */

/** 本地时区的今天零点 */
export function 今天零点(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** 这一条算不算逾期：有时间、早于今天零点。没定时间的不算逾期（计划页把它放在「以后」） */
export function 是逾期(时间: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!时间) return false;
  const t = typeof 时间 === "string" ? new Date(时间) : 时间;
  return t.getTime() < 今天零点(now).getTime();
}

/** 算谁的：给 ownerId 就是「我的」，不给就是全团队 */
export type 逾期范围 = { ownerId?: string };

/** 两张表各自的查询条件。只在这里写一次，三处共用 */
export function 逾期条件(范围: 逾期范围 = {}, now: Date = new Date()) {
  const 截止 = 今天零点(now);
  const 谁 = 范围.ownerId ? { ownerId: 范围.ownerId } : {};
  return {
    plan: { ...谁, done: false, plannedAt: { lt: 截止 } },
    task: { ...谁, done: false, dueAt: { lt: 截止 } },
  };
}

/** 只要两张表的 count：调用方把 prisma 传进来，这个文件就不必 import 服务端的库 */
type 能数的库 = {
  followPlan: { count: (a: { where: ReturnType<typeof 逾期条件>["plan"] }) => Promise<number> };
  task: { count: (a: { where: ReturnType<typeof 逾期条件>["task"] }) => Promise<number> };
};

/** 逾期跟进数 = 逾期的计划 + 逾期的待办 */
export async function 数逾期跟进(db: 能数的库, 范围: 逾期范围 = {}, now: Date = new Date()): Promise<number> {
  const w = 逾期条件(范围, now);
  const [计划, 待办] = await Promise.all([db.followPlan.count({ where: w.plan }), db.task.count({ where: w.task })]);
  return 计划 + 待办;
}
