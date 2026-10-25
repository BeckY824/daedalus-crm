import { prisma, defaultClient } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { 搜索词 } from "@/lib/search-keyword";
import { 带过来的客户 } from "@/lib/options";
import OpportunitiesView, { type OppRow } from "./OpportunitiesView";
import type { Prisma } from "@/generated/prisma";
import { 负责人候选 } from "@/lib/owners";
import { 带币种, 商机币种 } from "@/lib/money-db";
import { 商机汇总 } from "@/lib/opportunity-summary";
import { 限定的我 } from "@/lib/team-scope";

export const dynamic = "force-dynamic";
const opportunityInclude = {
  customer: { select: { id: true, name: true, school: true } },
  owner: { select: { id: true, name: true } },
  ...带币种.商机,
} satisfies Prisma.OpportunityInclude;
function opportunityRow(o: Prisma.OpportunityGetPayload<{ include: typeof opportunityInclude }>): OppRow {
  return { id: o.id, name: o.name, amount: o.amount, currency: 商机币种(o), stage: o.stage, status: o.status,
    probability: o.probability, updatedAt: o.updatedAt.toISOString(), expectedDealAt: o.expectedDealAt?.toISOString() ?? null,
    createdAt: o.createdAt.toISOString(), remark: o.remark, customerId: o.customer.id, customerName: o.customer.name, customerCompany: o.customer.school,
    ownerId: o.owner.id, ownerName: o.owner.name };
}

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ keyword?: string; stage?: string; status?: string; ownerId?: string; opportunity?: string; new?: string; customer?: string }>;
}) {
  await requireUser();
  const sp = await searchParams;
  // 关键词去掉前后空格再搜（2026-10-04 J-008）：复制来的「张三 」原来一个都搜不到
  const 词 = 搜索词(sp.keyword);

  const where: Prisma.OpportunityWhereInput = {
    ...(词
      ? { OR: [{ name: { contains: 词 } }, { customer: { name: { contains: 词 } } }, { customer: { school: { contains: 词 } } }] }
      : {}),
    ...(sp.stage ? { stage: sp.stage } : {}),
    ...(sp.status ? { status: sp.status } : {}),
    ...(sp.ownerId ? { ownerId: sp.ownerId } : {}),
  };

  const [总数, 汇总, rows, users, preselected, focused] = await Promise.all([
    // take: 300 取回来的行数不是总数，分页条会拿它冒充总数。见 leads/page.tsx 的说明
    prisma.opportunity.count({ where }),
    /*
      汇总药丸按全量算（排查 C7）：原来拿取回来的前 300 行加，商机一多就和卡片上的数对不上。
      没筛状态时只算进行中的（审查 M12 的口径）。不限定时在库里按币种加（企业版 1 万商机 30 → 2 毫秒），见 lib/opportunity-summary.ts
    */
    (async () => 商机汇总(prisma, where, { 关键词: 词, stage: sp.stage, status: sp.status, ownerId: sp.ownerId }, !(await 限定的我(defaultClient))))(),
    prisma.opportunity.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 300,
      include: opportunityInclude,
    }),
    负责人候选(),
    typeof sp.customer === "string" ? 带过来的客户(sp.customer) : null,
    typeof sp.opportunity === "string" && sp.opportunity.length > 0 && sp.opportunity.length <= 256
      ? prisma.opportunity.findUnique({ where: { id: sp.opportunity }, include: opportunityInclude }) : null,
  ]);

  return (
    <OpportunitiesView
      key={typeof sp.opportunity === "string" ? sp.opportunity : sp.new === "1" ? `new-${preselected?.id ?? "none"}` : "list"}
      focusedOpportunity={focused ? opportunityRow(focused) : null}
      directNew={sp.new === "1" && !sp.opportunity}
      initialCustomer={preselected}
      focusMissing={Boolean(sp.opportunity) && !focused}
      总数={总数}
      汇总={汇总}
      users={users}
      customers={[]}
      filters={{
        keyword: sp.keyword ?? "",
        stage: sp.stage ?? "",
        status: sp.status ?? "",
        ownerId: sp.ownerId ?? "",
      }}
      rows={rows.map(opportunityRow)}
    />
  );
}
