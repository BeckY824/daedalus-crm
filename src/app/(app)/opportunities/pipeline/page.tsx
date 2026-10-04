import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import PipelineView from "./PipelineView";
import { 可选客户 } from "@/lib/options";
import { 负责人候选 } from "@/lib/owners";
import { 带币种, 商机币种 } from "@/lib/money-db";
import { dayjs } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** 赢单列摆近几天赢下的（2026-10-04 J-090）。page 文件只许导出 Next 认的那几样，所以不 export */
const 赢单列天数 = 30;

export default async function PipelinePage() {
  await requireUser();
  /*
    赢单列摆近 30 天赢下的（2026-10-04 J-090）。原来只取进行中的：拖进「赢单成交」那一刻卡片就消失了，
    人以为拖丢了；而赢单列永远是空的。全摆出来又会越积越长、列头合计成了历年总额，所以只摆近 30 天。
    老商机没有结单时刻那一行（0.46.15 之前赢的），退回按 updatedAt 算。
  */
  const 起 = dayjs().subtract(赢单列天数, "day").toDate();

  const [opps, users, customers] = await Promise.all([
    prisma.opportunity.findMany({
      where: {
        OR: [
          { status: "OPEN" },
          { status: "WON", OR: [{ closed: { is: { closedAt: { gte: 起 } } } }, { closed: { is: null }, updatedAt: { gte: 起 } }] },
        ],
      },
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
      赢单天数={赢单列天数}
      users={users}
      customers={customers}
      rows={opps.map((o) => ({
        id: o.id,
        name: o.name,
        amount: o.amount,
        currency: 商机币种(o),
        stage: o.stage,
        status: o.status,
        probability: o.probability,
        expectedDealAt: o.expectedDealAt?.toISOString() ?? null,
        customerId: o.customer.id,
        customerName: o.customer.name,
        ownerName: o.owner.name,
      }))}
    />
  );
}
