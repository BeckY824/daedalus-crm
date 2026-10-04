import { notFound } from "next/navigation";
import { 收藏了吗 } from "@/lib/favorites";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import RecordView from "./RecordView";
import { 负责人候选 } from "@/lib/owners";
import { 可选渠道, 可选客户 } from "@/lib/options";
import { llmEnabled } from "@/lib/llm";
import { 号码脱敏器 } from "@/lib/shared-ws/current";
import { 带币种, 签约金额, 签约币种, 签约合计, 商机币种 } from "@/lib/money-db";
import { 客户报价记录 } from "@/lib/quote-db";
import { 报价明细 } from "@/lib/features";
import { 订单列表 } from "@/lib/order-db";

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
      // 该学员自己推荐来的人，用于展示推荐链下游
      referrals: { select: { id: true, name: true, followStatus: true }, orderBy: { createdAt: "desc" } },
      contracts: { orderBy: { signedAt: "desc" }, include: 带币种.签约 },
      contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      opportunities: { orderBy: { createdAt: "desc" }, include: 带币种.商机 },
      tasks: { orderBy: [{ done: "asc" }, { dueAt: "asc" }] },
      plans: { where: { done: false, ...(要看的计划 ? { id: 要看的计划 } : {}) }, orderBy: { plannedAt: "asc" }, take: 1 },
      followUps: {
        orderBy: { occurredAt: "desc" },
        take: 50,
        include: {
          owner: { select: { name: true } },
          contact: { select: { name: true, position: true } },
          source: { select: { text: true } },
        },
      },
    },
  });

  if (!customer) notFound();
  // 叫你的那条已经做完 / 删了：照旧摆最早那条没做完的
  if (要看的计划 && customer.plans.length === 0) {
    customer.plans = await prisma.followPlan.findMany({ where: { customerId: id, done: false }, orderBy: { plannedAt: "asc" }, take: 1 });
  }

  // 演示区是公开的，同一份数据所有访客共用：号码一律打码。
  // 自己部署的实例不受影响——销售要照着这个号打电话。
  const 号 = await 号码脱敏器();

  const [users, channels, referrableCustomers] = await Promise.all([
    负责人候选(),
    可选渠道(),
    // 排除自己，避免把自己设为推荐人导致推荐链成环
    可选客户(id),
  ]);

  /*
    这儿原来算了一组「沟通统计」（跟进次数 / 累计通话时长 / 会议数 / 邮件数）
    并一路传到 RecordView——而 RecordView 从来没解构过它，界面上一个字都没有。
    2026-09-19 删掉。两个理由：
      1. 算了不显示的数据就是死代码，类型里还占着一行，下一个人会以为它在用
      2. **它还是错的**：上面那个 followUps 带着 `take: 50`，所以这组数是从
         最近 50 条里算的。真接上去的话，跟进超过 50 次的人「累计通话时长」
         会停止增长——一个只在老客户身上出错的数，最不容易被发现。
    要做这组数得单独 groupBy 聚合，不能借那 50 条现成的行。
  */
  return (
    <RecordView
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
        expectedSignAt: customer.expectedSignAt?.toISOString() ?? null,
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
      订单={await 订单列表({ customerId: customer.id })}
      contracts={customer.contracts.map((c) => ({
        id: c.id,
        amount: 签约金额(c),
        currency: 签约币种(c),
        signedAt: c.signedAt.toISOString(),
        remark: c.remark,
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
      }))}
      tasks={customer.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        dueAt: t.dueAt?.toISOString() ?? null,
        done: t.done,
      }))}
      plan={
        customer.plans[0]
          ? {
              id: customer.plans[0].id,
              subject: customer.plans[0].subject,
              plannedAt: customer.plans[0].plannedAt.toISOString(),
              method: customer.plans[0].method,
              updatedAt: customer.plans[0].updatedAt.toISOString(),
            }
          : null
      }
      followUps={customer.followUps.map((f) => ({
        id: f.id,
        type: f.type,
        title: f.title,
        content: f.content,
        status: f.status,
        duration: f.duration,
        occurredAt: f.occurredAt.toISOString(),
        dueAt: f.dueAt?.toISOString() ?? null,
        participants: f.participants,
        sourceText: f.source?.text ?? null,
        ownerName: f.owner.name,
        contactName: f.contact?.name ?? null,
        contactPosition: f.contact?.position ?? null,
        contactId: f.contactId,
        opportunityId: f.opportunityId,
        updatedAt: f.updatedAt.toISOString(),
      }))}
    />
  );
}
