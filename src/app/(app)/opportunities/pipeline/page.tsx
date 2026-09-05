import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import PipelineView from "./PipelineView";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  await requireUser();

  const opps = await prisma.opportunity.findMany({
    where: { status: "OPEN" },
    orderBy: { amount: "desc" },
    include: {
      customer: { select: { id: true, name: true } },
      owner: { select: { name: true } },
    },
  });

  return (
    <PipelineView
      rows={opps.map((o) => ({
        id: o.id,
        name: o.name,
        amount: o.amount,
        stage: o.stage,
        probability: o.probability,
        expectedDealAt: o.expectedDealAt?.toISOString() ?? null,
        customerId: o.customer.id,
        customerName: o.customer.name,
        ownerName: o.owner.name,
      }))}
    />
  );
}
