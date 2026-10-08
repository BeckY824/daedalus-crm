import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import PlansView from "./PlansView";
import { 带过来的客户 } from "@/lib/options";

export const dynamic = "force-dynamic";

export default async function PlansPage({
  searchParams,
}: {
  /** customer：从某位客户带过来的，「新建计划」预填他；new=1：进来就把新建框打开 */
  searchParams: Promise<{ customer?: string; new?: string; scope?: string }>;
}) {
  const me = await requireUser();
  const sp = await searchParams;

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
  const [plans, tasks, teamPlans, teamTasks, myPlans, myTasks, 预选客户] = await Promise.all([
    prisma.followPlan.findMany({
      where: { done: false },
      orderBy: { plannedAt: "asc" },
      include: {
        customer: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
      },
    }),
    prisma.task.findMany({
      where: { done: false },
      orderBy: { dueAt: { sort: "asc", nulls: "last" } },
      include: {
        customer: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
      },
    }),
    completedPlans(), completedTasks(), completedPlans(me.id), completedTasks(me.id),
    带过来的客户(sp.customer),
  ]);

  return (
    <PlansView
      meId={me.id}
      预选客户={预选客户}
      直接新建={sp.new === "1"}
      全员={sp.scope === "all"}
      plans={plans.map((p) => ({
        id: p.id,
        subject: p.subject,
        plannedAt: p.plannedAt.toISOString(),
        method: p.method,
        updatedAt: p.updatedAt.toISOString(),
        customerId: p.customer.id,
        customerName: p.customer.name,
        ownerId: p.owner.id,
        ownerName: p.owner.name,
      }))}
      tasks={tasks.map((t) => ({
        id: t.id,
        title: t.title,
        dueAt: t.dueAt?.toISOString() ?? null,
        updatedAt: t.updatedAt.toISOString(),
        customerId: t.customer.id,
        customerName: t.customer.name,
        ownerId: t.owner.id,
        ownerName: t.owner.name,
      }))}
      done={[
        ...[...new Map([...teamPlans, ...myPlans].map(p => [p.id, p])).values()].map((p) => ({
          key: `plan:${p.id}`,
          kind: "plan" as const,
          标题: p.subject,
          方式: p.method,
          计划时间: p.plannedAt.toISOString(),
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
          计划时间: t.dueAt?.toISOString() ?? null,
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
