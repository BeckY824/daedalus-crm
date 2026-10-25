import { scheduleValue } from "@/lib/schedule-date";
import { prisma, defaultClient } from "@/lib/prisma";
import { 限定的我 } from "@/lib/team-scope";
import { 缓存着 } from "@/lib/home-cache";
import { requireUser } from "@/lib/auth";
import PlansView from "./PlansView";
import { 带过来的客户 } from "@/lib/options";
import { 取计划页 } from "@/lib/plans-page";
import { 压轻 } from "@/lib/plans-light";
import { 读每组 } from "@/lib/plans-groups";
import { 补计划详情 } from "./plan-rows";

export const dynamic = "force-dynamic";

export default async function PlansPage({
  searchParams = Promise.resolve({}),
}: {
  /** customer：从某位客户带过来的，「新建计划」预填他；new=1：进来就把新建框打开；n：每组摆几条（lib/plans-groups.ts） */
  searchParams?: Promise<{ customer?: string; new?: string; scope?: string; n?: string }>;
}) {
  const me = await requireUser();
  const sp = await searchParams;
  const 每组 = 读每组(sp.n);

  // Fetch team and personal windows separately: a busy team must not push my history out.
  const completedPlans = (ownerId?: string) => prisma.followPlan.findMany({
    where: { done: true, ...(ownerId ? { ownerId } : {}) },
    orderBy: [{ doneAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    take: 200,
    include: { customer: { select: { id: true, name: true } }, owner: { select: { id: true, name: true } } },
  });
  const completedTasks = (ownerId?: string) => prisma.task.findMany({
    where: { done: true, ...(ownerId ? { ownerId } : {}) },
    orderBy: [{ doneAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    take: 200,
    include: { customer: { select: { id: true, name: true } }, owner: { select: { id: true, name: true } } },
  });
  const [{ plans, tasks, 轻, 负责人 }, teamPlans, teamTasks, myPlans, myTasks, 预选客户] = await Promise.all([
    // 不限定（老板、个人版、企业版没开按组织看）时轻列表走短时缓存（lib/plans-page.ts）
    (async () => 取计划页(prisma, 每组, me.id, (await 限定的我(defaultClient)) ? undefined : 缓存着))(),
    completedPlans(), completedTasks(), completedPlans(me.id), completedTasks(me.id),
    带过来的客户(sp.customer),
  ]);

  // 轻列表按列压紧再给页面（lib/plans-light.ts）：企业版 1.5 万条时页面小一半；压不了的照原样给
  const 紧 = 轻 && 负责人 ? 压轻(轻, 负责人) : null;

  return (
    <PlansView
      meId={me.id}
      预选客户={预选客户}
      直接新建={sp.new === "1"}
      全员={sp.scope === "all"}
      plans={plans}
      tasks={tasks}
      {...(轻 ? { ...(紧 ? { 紧 } : { 轻, 负责人 }), 每组, 补详情: 补计划详情 } : {})}
      done={[
        ...[...new Map([...teamPlans, ...myPlans].map(p => [p.id, p])).values()].map((p) => ({
          key: `plan:${p.id}`,
          kind: "plan" as const,
          标题: p.subject,
          方式: p.method,
          计划时间: scheduleValue(p.plannedAt, p.plannedOn)!,
          完成时间: p.doneAt?.toISOString() ?? null,
          customerId: p.customer.id,
          customerName: p.customer.name,
          ownerId: p.owner.id,
          ownerName: p.owner.name,
        })),
        ...[...new Map([...teamTasks, ...myTasks].map(t => [t.id, t])).values()].map((t) => ({
          key: `task:${t.id}`,
          kind: "task" as const,
          标题: t.title,
          方式: undefined,
          计划时间: scheduleValue(t.dueAt, t.dueOn),
          完成时间: t.doneAt?.toISOString() ?? null,
          customerId: t.customer.id,
          customerName: t.customer.name,
          ownerId: t.owner.id,
          ownerName: t.owner.name,
        })),
      ].sort((a, b) => (b.完成时间 ?? "").localeCompare(a.完成时间 ?? "") || a.key.localeCompare(b.key))}
    />
  );
}
