import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import OpportunitiesView from "./OpportunitiesView";
import type { Prisma } from "@/generated/prisma";
import { 可担任负责人 } from "@/lib/constants";

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ keyword?: string; stage?: string; status?: string; ownerId?: string }>;
}) {
  await requireUser();
  const sp = await searchParams;

  const where: Prisma.OpportunityWhereInput = {
    ...(sp.keyword
      ? { OR: [{ name: { contains: sp.keyword } }, { customer: { name: { contains: sp.keyword } } }] }
      : {}),
    ...(sp.stage ? { stage: sp.stage } : {}),
    ...(sp.status ? { status: sp.status } : {}),
    ...(sp.ownerId ? { ownerId: sp.ownerId } : {}),
  };

  const [rows, users, customers] = await Promise.all([
    prisma.opportunity.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 300,
      include: {
        customer: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
      },
    }),
    prisma.user.findMany({ where: 可担任负责人, select: { id: true, name: true, email: true } }),
    prisma.customer.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <OpportunitiesView
      users={users}
      customers={customers}
      filters={{
        keyword: sp.keyword ?? "",
        stage: sp.stage ?? "",
        status: sp.status ?? "",
        ownerId: sp.ownerId ?? "",
      }}
      rows={rows.map((o) => ({
        id: o.id,
        name: o.name,
        amount: o.amount,
        stage: o.stage,
        status: o.status,
        probability: o.probability,
        expectedDealAt: o.expectedDealAt?.toISOString() ?? null,
        remark: o.remark,
        customerId: o.customer.id,
        customerName: o.customer.name,
        ownerId: o.owner.id,
        ownerName: o.owner.name,
      }))}
    />
  );
}
