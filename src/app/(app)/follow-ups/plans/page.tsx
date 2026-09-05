import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import PlansView from "./PlansView";

export const dynamic = "force-dynamic";

export default async function PlansPage() {
  const me = await requireUser();

  const [plans, tasks] = await Promise.all([
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
    />
  );
}
