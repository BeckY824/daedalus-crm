import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { 搜索词 } from "@/lib/search-keyword";
import { 可选客户 } from "@/lib/options";
import OpportunitiesView from "./OpportunitiesView";
import type { Prisma } from "@/generated/prisma";
import { 负责人候选 } from "@/lib/owners";
import { 带币种, 商机币种 } from "@/lib/money-db";
import { 按币种合计 } from "@/lib/currency";

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ keyword?: string; stage?: string; status?: string; ownerId?: string }>;
}) {
  await requireUser();
  const sp = await searchParams;
  // 关键词去掉前后空格再搜（2026-10-04 J-008）：复制来的「张三 」原来一个都搜不到
  const 词 = 搜索词(sp.keyword);

  const where: Prisma.OpportunityWhereInput = {
    ...(词
      ? { OR: [{ name: { contains: 词 } }, { customer: { name: { contains: 词 } } }] }
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
      select: { amount: true, probability: true, status: true, ...带币种.商机 },
    }),
    prisma.opportunity.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 300,
      include: {
        customer: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
        ...带币种.商机,
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
        // 按币种分开（不换汇）：美元单和人民币单加在一起是假数字
        合计: 按币种合计(汇总行, (o) => o.amount, 商机币种),
        预测: 按币种合计(汇总行.filter((o) => o.status === "OPEN"), (o) => o.amount * (o.probability / 100), 商机币种),
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
        currency: 商机币种(o),
        stage: o.stage,
        status: o.status,
        probability: o.probability,
        updatedAt: o.updatedAt.toISOString(),
        expectedDealAt: o.expectedDealAt?.toISOString() ?? null,
        createdAt: o.createdAt.toISOString(),
        remark: o.remark,
        customerId: o.customer.id,
        customerName: o.customer.name,
        ownerId: o.owner.id,
        ownerName: o.owner.name,
      }))}
    />
  );
}
