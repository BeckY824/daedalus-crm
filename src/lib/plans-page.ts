import type { Prisma, PrismaClient } from "@/generated/prisma";
import { scheduleValue } from "@/lib/schedule-date";
import { 分组, 组名, 每批 } from "@/lib/plans-groups";

/**
 * 跟进计划页一页取多少（2026-10-24 企业版压测）。
 *
 * 原来一次把没做完的计划和待办全取回来、全画成行：企业版 1 万条计划 + 5 千条待办时整页 HTML 5.7 MB，
 * 30 人同时开就排队。现在和商机看板（lib/pipeline-page.ts）一样分两步：
 *   1. 轻查询：同一个 where，只取 id、时间、负责人。这一份「全部」交给页面，组头的条数、
 *      「我的 / 全部成员」、「你名下没有；全部成员还有 N 条」都在它上面算，和原来一模一样。
 *   2. 每组只取前 N 条的详情（默认 50；「我的」和「全部成员」两种看法各取前 N），「再看 50 条」加大 N。
 *
 * 全部都取回来了的时候（个人版几乎都是），页面拿到的东西和原来一模一样，不带轻列表。
 * 排序在时间之外加了 id：同一时刻的先后原来由库决定（不稳定），分批时必须稳定，否则翻页会重复、漏行。
 */

const 计划排序: Prisma.FollowPlanOrderByWithRelationInput[] = [{ plannedAt: "asc" }, { id: "asc" }];
const 待办排序: Prisma.TaskOrderByWithRelationInput[] = [{ dueAt: { sort: "asc", nulls: "last" } }, { id: "asc" }];
// 没翻过页、全取回来时照原来的排序（不加 id）：个人版拿到的和原来一个字节都不差
const 原计划排序: Prisma.FollowPlanOrderByWithRelationInput = { plannedAt: "asc" };
const 原待办排序: Prisma.TaskOrderByWithRelationInput = { dueAt: { sort: "asc", nulls: "last" } };

const 计划详情 = {
  // 有 WhatsApp 号的：完成小框的方式默认 WhatsApp（2026-10-17 PR26 手测）
  customer: { select: { id: true, name: true, extra: { select: { whatsapp: true } } } },
  owner: { select: { id: true, name: true } },
} satisfies Prisma.FollowPlanInclude;
const 待办详情 = {
  customer: { select: { id: true, name: true } },
  owner: { select: { id: true, name: true } },
} satisfies Prisma.TaskInclude;

export type 计划行 = {
  id: string;
  subject: string;
  plannedAt: string;
  plannedHasTime: boolean | null;
  method: string;
  updatedAt: string;
  customerId: string;
  customerName: string;
  有WhatsApp: boolean;
  ownerId: string;
  ownerName: string;
};

export type 待办行 = {
  id: string;
  title: string;
  dueAt: string | null;
  dueHasTime: boolean | null;
  updatedAt: string;
  customerId: string;
  customerName: string;
  ownerId: string;
  ownerName: string;
};

/** 轻列表的一行：[key, 时间, 负责人在 负责人 里的下标]。先计划后待办，各按库里的顺序 */
export type 轻行 = [string, string | null, number];

export type 计划页 = {
  plans: 计划行[];
  tasks: 待办行[];
  /** 没全取回来时才有：全部未完成事项的轻列表 */
  轻?: 轻行[];
  负责人?: string[];
};

type Db = Pick<PrismaClient, "followPlan" | "task">;

const 成计划 = (p: Prisma.FollowPlanGetPayload<{ include: typeof 计划详情 }>): 计划行 => ({
  id: p.id,
  subject: p.subject,
  plannedAt: scheduleValue(p.plannedAt, p.plannedOn)!,
  plannedHasTime: p.plannedHasTime,
  method: p.method,
  updatedAt: p.updatedAt.toISOString(),
  customerId: p.customer.id,
  customerName: p.customer.name,
  有WhatsApp: !!p.customer.extra?.whatsapp?.trim(),
  ownerId: p.owner.id,
  ownerName: p.owner.name,
});

const 成待办 = (t: Prisma.TaskGetPayload<{ include: typeof 待办详情 }>): 待办行 => ({
  id: t.id,
  title: t.title,
  dueAt: scheduleValue(t.dueAt, t.dueOn),
  dueHasTime: t.dueHasTime,
  updatedAt: t.updatedAt.toISOString(),
  customerId: t.customer.id,
  customerName: t.customer.name,
  ownerId: t.owner.id,
  ownerName: t.owner.name,
});

/**
 * 按 key（plan:… / task:…）取详情，只取还没做完的；顺序同轻列表。
 * 稳定排序：加 id 定同一时刻的先后。翻过页（再看到底）时也要加，否则最后一下同一时刻的几条会换位置。
 */
export async function 取详情(db: Db, keys: readonly string[] | "全部", 稳定排序 = keys !== "全部"): Promise<Pick<计划页, "plans" | "tasks">> {
  const 只要 = (前缀: string): { id?: { in: string[] } } => (keys === "全部" ? {} : { id: { in: keys.filter((k) => k.startsWith(前缀)).map((k) => k.slice(前缀.length)) } });
  const 计划条件 = 只要("plan:");
  const 待办条件 = 只要("task:");
  const [plans, tasks] = await Promise.all([
    计划条件.id?.in.length === 0 ? [] : db.followPlan.findMany({ where: { done: false, ...计划条件 }, orderBy: 稳定排序 ? 计划排序 : 原计划排序, include: 计划详情 }),
    待办条件.id?.in.length === 0 ? [] : db.task.findMany({ where: { done: false, ...待办条件 }, orderBy: 稳定排序 ? 待办排序 : 原待办排序, include: 待办详情 }),
  ]);
  return { plans: plans.map(成计划), tasks: tasks.map(成待办) };
}

export async function 取计划页(db: Db, 每组: readonly number[], meId: string): Promise<计划页> {
  const [轻计划, 轻待办] = await Promise.all([
    db.followPlan.findMany({ where: { done: false }, orderBy: 计划排序, select: { id: true, plannedAt: true, plannedOn: true, ownerId: true } }),
    db.task.findMany({ where: { done: false }, orderBy: 待办排序, select: { id: true, dueAt: true, dueOn: true, ownerId: true } }),
  ]);
  const 全部 = [
    ...轻计划.map((p) => ({ key: `plan:${p.id}`, 时间: scheduleValue(p.plannedAt, p.plannedOn), ownerId: p.ownerId })),
    ...轻待办.map((t) => ({ key: `task:${t.id}`, 时间: scheduleValue(t.dueAt, t.dueOn), ownerId: t.ownerId })),
  ];

  // 两种看法各挑每组前 N 条
  const 要 = new Set<string>();
  for (const 这些 of [全部, 全部.filter((x) => x.ownerId === meId)]) {
    const 组 = 分组(这些);
    组名.forEach((g, i) => { for (const x of 组[g].slice(0, 每组[i])) 要.add(x.key); });
  }

  // 全都要摆（个人版几乎都是）：照原来那样整取，页面拿到的和原来一模一样；翻过页的照分批时的顺序
  if (要.size === 全部.length) return 取详情(db, "全部", 每组.some((n) => n > 每批));
  const 详 = await 取详情(db, [...要]);

  const 负责人 = [...new Set(全部.map((x) => x.ownerId))];
  const 下标 = new Map(负责人.map((id, i) => [id, i]));
  return { ...详, 轻: 全部.map((x) => [x.key, x.时间, 下标.get(x.ownerId)!]), 负责人 };
}
