import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { 可选客户 } from "@/lib/options";
import OpportunitiesView from "./OpportunitiesView";
import type { Prisma } from "@/generated/prisma";
import { 负责人候选 } from "@/lib/owners";

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

  const [总数, 汇总行, rows, users, customers] = await Promise.all([
    // take: 300 取回来的行数不是总数，分页条会拿它冒充总数。见 leads/page.tsx 的说明
    prisma.opportunity.count({ where }),
    /*
      汇总药丸按全量算（排查 C7）：原来拿取回来的前 300 行加，商机一多就和卡片上的数对不上。
      没筛状态时只算进行中的（审查 M12 的口径），只要金额和概率两列，很轻
    */
    prisma.opportunity.findMany({
      where: { ...where, ...(sp.status ? {} : { status: "OPEN" }) },
      select: { amount: true, probability: true, status: true },
    }),
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
    可选客户(),
  ]);

  return (
    <OpportunitiesView
      总数={总数}
      汇总={{
        单数: 汇总行.length,
        合计: 汇总行.reduce((s, o) => s + o.amount, 0),
        预测: 汇总行.filter((o) => o.status === "OPEN").reduce((s, o) => s + o.amount * (o.probability / 100), 0),
      }}
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
