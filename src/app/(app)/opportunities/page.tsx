import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import OpportunitiesView from "./OpportunitiesView";
import type { Prisma } from "@/generated/prisma";
import { 负责人候选 } from "@/lib/owners";

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ keyword?: string; stage?: string; status?: string; ownerId?: string; new?: string }>;
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

  const [总数, rows, users, customers] = await Promise.all([
    // take: 300 取回来的行数不是总数，分页条会拿它冒充总数。见 leads/page.tsx 的说明
    prisma.opportunity.count({ where }),
    prisma.opportunity.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 300,
      include: {
        customer: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
      },
    }),
    负责人候选(),
    prisma.customer.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <OpportunitiesView
      总数={总数}
      users={users}
      customers={customers}
      /* 管道页的「新建商机」落在这儿：那一页没有表单，带上 ?new=1 回列表页直接把它打开 */
      直接新建={sp.new === "1"}
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
