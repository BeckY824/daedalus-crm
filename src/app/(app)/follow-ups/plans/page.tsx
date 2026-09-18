import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import PlansView from "./PlansView";

export const dynamic = "force-dynamic";

export default async function PlansPage() {
  const me = await requireUser();

  /*
    「完成之后去哪了」这一页原来答不上来：三处读取全是 done: false，
    点完成那一下之后，那条计划从界面上彻底消失——2026-09-18 问到的。
    所以这里把做完的也取回来，按完成时间倒序，界面上用一个切换看。
    只取最近 200 条：这一页是回顾，不是档案馆；再往前翻属于操作日志的事。
  */
  const [plans, tasks, donePlans, doneTasks] = await Promise.all([
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
      orderBy: { dueAt: "asc" },
      include: {
        customer: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
      },
    }),
    /*
      FollowPlan 没有 doneAt 列，用 updatedAt 当完成时间。
      completePlan 是唯一一处把 done 置为 true 的地方，而完成之后这条计划
      在界面上再也改不到，所以这两个时间是同一刻。
      （加列要走 migrations/，那儿只能加表不能加列——见它的 README。）
    */
    prisma.followPlan.findMany({
      where: { done: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
      include: {
        customer: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
      },
    }),
    prisma.task.findMany({
      where: { done: true },
      orderBy: { doneAt: "desc" },
      take: 200,
      include: {
        customer: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
      },
    }),
  ]);

  return (
    <PlansView
      meId={me.id}
      plans={plans.map((p) => ({
        id: p.id,
        subject: p.subject,
        plannedAt: p.plannedAt.toISOString(),
        method: p.method,
        customerId: p.customer.id,
        customerName: p.customer.name,
        ownerId: p.owner.id,
        ownerName: p.owner.name,
      }))}
      tasks={tasks.map((t) => ({
        id: t.id,
        title: t.title,
        dueAt: t.dueAt?.toISOString() ?? null,
        customerId: t.customer.id,
        customerName: t.customer.name,
        ownerId: t.owner.id,
        ownerName: t.owner.name,
      }))}
      done={[
        ...donePlans.map((p) => ({
          key: `plan:${p.id}`,
          kind: "plan" as const,
          标题: p.subject,
          方式: p.method,
          计划时间: p.plannedAt.toISOString(),
          完成时间: p.updatedAt.toISOString(),
          customerId: p.customer.id,
          customerName: p.customer.name,
          ownerId: p.owner.id,
          ownerName: p.owner.name,
        })),
        ...doneTasks.map((t) => ({
          key: `task:${t.id}`,
          kind: "task" as const,
          标题: t.title,
          方式: undefined,
          计划时间: t.dueAt?.toISOString() ?? null,
          完成时间: (t.doneAt ?? t.updatedAt).toISOString(),
          customerId: t.customer.id,
          customerName: t.customer.name,
          ownerId: t.owner.id,
          ownerName: t.owner.name,
        })),
      ].sort((a, b) => b.完成时间.localeCompare(a.完成时间))}
    />
  );
}
