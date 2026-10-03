import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import PipelineView from "./PipelineView";
import { 可选客户 } from "@/lib/options";
import { 负责人候选 } from "@/lib/owners";
import { 带币种, 商机币种 } from "@/lib/money-db";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  await requireUser();

  const [opps, users, customers] = await Promise.all([
    prisma.opportunity.findMany({
      where: { status: "OPEN" },
      orderBy: { amount: "desc" },
      include: {
        customer: { select: { id: true, name: true } },
        owner: { select: { name: true } },
        ...带币种.商机,
      },
    }),
    // 新建框要的候选：和列表页同一个框（../OpportunityForm.tsx）
    负责人候选(),
    可选客户(),
  ]);

  return (
    <PipelineView
      users={users}
      customers={customers}
      rows={opps.map((o) => ({
        id: o.id,
        name: o.name,
        amount: o.amount,
        currency: 商机币种(o),
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
