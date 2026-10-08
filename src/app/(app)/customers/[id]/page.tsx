import { scheduleValue, scheduleOrder, earliestScheduled } from "@/lib/schedule-date";
import { notFound } from "next/navigation";
import { 收藏了吗 } from "@/lib/favorites";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import RecordView from "./RecordView";
import { followHistoryInclude, followHistoryOrder, serializeFollowHistory } from "./follow-history-query";
import { 负责人候选 } from "@/lib/owners";
import { 可选渠道, 可选客户 } from "@/lib/options";
import { llmEnabled } from "@/lib/llm";
import { 号码脱敏器 } from "@/lib/shared-ws/current";
import { 带币种, 签约金额, 签约币种, 签约合计, 商机币种 } from "@/lib/money-db";
import { 客户报价记录 } from "@/lib/quote-db";
import { 报价明细 } from "@/lib/features";
import { 客户来源线索 } from "@/lib/customer-lead-origin";
import { 取档案 } from "@/lib/customer-extra-db";

export const dynamic = "force-dynamic";

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ focus?: string }>;
}) {
  const me = await requireUser();
  const { id } = await params;
  /*
    从到点提醒点进来（?focus=plan:…）：记录页只摆一条计划（最早那条），叫你的那条若不是最早的，
    点进来就找不到它、也闪不了（2026-10-02 排查 3-3）。这时摆的是叫你的那一条
  */
  const 要看的计划 = /^plan:(.+)$/.exec((await searchParams).focus ?? "")?.[1] ?? null;

  const customer = await prisma.customer.findUnique({
    where: { id },
    include: {
      salesOwner: { select: { id: true, name: true } },
      channelOwner: { select: { id: true, name: true } },
      channel: { select: { id: true, name: true } },
      referrerCustomer: { select: { id: true, name: true } },
      attributionChannel: { select: { name: true } },
      attributionCustomer: { select: { id: true, name: true } },
      pool: { select: { reason: true } },
      extra: true,
      // 该学员自己推荐来的人，用于展示推荐链下游
      referrals: { select: { id: true, name: true, followStatus: true }, orderBy: { createdAt: "desc" } },
      // 签约带上它是哪张订单（外贸，2026-10-05）：订单号、付款方式、供应商
      contracts: {
        orderBy: { signedAt: "desc" },
        include: { ...带币种.签约, order: { select: { id: true, no: true, payment: true, purchase: { select: { supplierId: true, supplier: { select: { name: true } } } } } } },
      },
      contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      opportunities: { orderBy: { createdAt: "desc" }, include: 带币种.商机 },
      tasks: { orderBy: [{ done: "asc" }, { dueAt: "asc" }] },
      plans: { where: { done: false, ...(要看的计划 ? { id: 要看的计划 } : {}) }, orderBy: [{ plannedAt: "asc" }, { id: "asc" }] },
      followUps: { orderBy: followHistoryOrder, take: 51, include: followHistoryInclude },
    },
  });

  if (!customer) notFound();
  // 叫你的那条已经做完 / 删了：照旧摆最早那条没做完的
  if (要看的计划 && customer.plans.length === 0) {
    customer.plans = await prisma.followPlan.findMany({ where: { customerId: id, done: false }, orderBy: [{ plannedAt: "asc" }, { id: "asc" }] });
  }

  customer.plans = earliestScheduled(customer.plans, p => scheduleOrder(p.plannedAt, p.plannedOn), 1);

  // 演示区是公开的，同一份数据所有访客共用：号码一律打码。
  // 自己部署的实例不受影响——销售要照着这个号打电话。
  const 号 = await 号码脱敏器();

  const [users, channels, referrableCustomers] = await Promise.all([
    负责人候选(),
    可选渠道(),
    // 排除自己，避免把自己设为推荐人导致推荐链成环
    可选客户(id),
  ]);

  return (
    <RecordView
      key={customer.id}
      sourceLead={await 客户来源线索(customer.id)}
      users={users}
      channels={channels}
      referrableCustomers={referrableCustomers}
      aiEnabled={await llmEnabled()}
      已收藏={await 收藏了吗(me.id, id)}
      能放公海={me.role === "ADMIN" || customer.salesOwnerId === me.id}
      customer={{
        id: customer.id,
        name: customer.name,
        phone: 号(customer.phone),
        school: customer.school,
        grade: customer.grade,
        major: customer.major,
        followStatus: customer.followStatus,
        decisionStatus: customer.decisionStatus,
        expectedSignAt: scheduleValue(customer.expectedSignAt, customer.expectedSignOn),
        lastFollowAt: customer.lastFollowAt?.toISOString() ?? null,
        remark: customer.remark,
        referrerCustomerId: customer.referrerCustomerId,
        channelId: customer.channelId,
        referrerName: customer.referrerCustomer?.name ?? customer.channel?.name ?? null,
        attributionName: customer.attributionChannel?.name ?? customer.attributionCustomer?.name ?? null,
        channelOwnerId: customer.channelOwnerId,
        channelOwnerName: customer.channelOwner?.name ?? null,
        salesOwnerId: customer.salesOwnerId,
        salesOwnerName: customer.salesOwner.name,
        signedAmount: customer.contracts.reduce((a, c) => a + 签约金额(c), 0),
        signedTotals: 签约合计(customer.contracts),
        pool: customer.pool ? { reason: customer.pool.reason } : null,
        // WhatsApp 也是号码：共享试用区和电话一样打码
        extra: (() => { const x = 取档案(customer.extra); return { ...x, whatsapp: x.whatsapp && 号(x.whatsapp) }; })(),
        updatedAt: customer.updatedAt.toISOString(),
      }}
      contacts={customer.contacts.map((c) => ({
        id: c.id,
        name: c.name,
        position: c.position,
        phone: 号(c.phone),
        email: c.email,
        wechat: c.wechat,
        isPrimary: c.isPrimary,
        remark: c.remark,
        updatedAt: c.updatedAt.toISOString(),
      }))}
      报价记录={报价明细 ? await 客户报价记录(customer.id) : []}
      contracts={customer.contracts.map((c) => ({
        id: c.id,
        amount: 签约金额(c),
        currency: 签约币种(c),
        signedAt: c.signedAt.toISOString(),
        remark: c.remark,
        order: c.order ? { id: c.order.id, no: c.order.no, payment: c.order.payment, supplier: c.order.purchase?.supplier?.name ?? null, supplierId: c.order.purchase?.supplierId ?? null } : null,
      }))}
      opportunities={customer.opportunities.map((o) => ({
        id: o.id,
        name: o.name,
        amount: o.amount,
        currency: 商机币种(o),
        stage: o.stage,
        status: o.status,
        probability: o.probability,
        expectedDealAt: o.expectedDealAt?.toISOString() ?? null,
        createdAt: o.createdAt.toISOString(),
      }))}
      tasks={customer.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        dueAt: scheduleValue(t.dueAt, t.dueOn),
        dueHasTime: t.dueHasTime,
        done: t.done,
      }))}
      plan={
        customer.plans[0]
          ? {
              id: customer.plans[0].id,
              subject: customer.plans[0].subject,
              plannedAt: scheduleValue(customer.plans[0].plannedAt, customer.plans[0].plannedOn)!,
              plannedHasTime: customer.plans[0].plannedHasTime,
              method: customer.plans[0].method,
              updatedAt: customer.plans[0].updatedAt.toISOString(),
            }
          : null
      }
      followUps={customer.followUps.slice(0, 50).map(serializeFollowHistory)}
      followUpsHasMore={customer.followUps.length > 50}
    />
  );
}
