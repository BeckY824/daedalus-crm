import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import RecordView from "./RecordView";
import { 负责人候选 } from "@/lib/owners";
import { llmEnabled } from "@/lib/llm";
import { 号码脱敏器 } from "@/lib/shared-ws/current";

export const dynamic = "force-dynamic";

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireUser();
  const { id } = await params;

  const customer = await prisma.customer.findUnique({
    where: { id },
    include: {
      salesOwner: { select: { id: true, name: true } },
      channelOwner: { select: { id: true, name: true } },
      channel: { select: { id: true, name: true } },
      referrerCustomer: { select: { id: true, name: true } },
      attributionChannel: { select: { name: true } },
      attributionCustomer: { select: { id: true, name: true } },
      // 该学员自己推荐来的人，用于展示推荐链下游
      referrals: { select: { id: true, name: true, followStatus: true }, orderBy: { createdAt: "desc" } },
      contracts: { orderBy: { signedAt: "desc" } },
      contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      opportunities: { orderBy: { createdAt: "desc" } },
      tasks: { orderBy: [{ done: "asc" }, { dueAt: "asc" }] },
      plans: { where: { done: false }, orderBy: { plannedAt: "asc" }, take: 1 },
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

  // 演示区是公开的，同一份数据所有访客共用：号码一律打码。
  // 自己部署的实例不受影响——销售要照着这个号打电话。
  const 号 = await 号码脱敏器();

  const [users, channels, referrableCustomers] = await Promise.all([
    负责人候选(),
    prisma.channel.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    // 排除自己，避免把自己设为推荐人导致推荐链成环
    prisma.customer.findMany({ where: { id: { not: id } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
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
        signedAmount: customer.contracts.reduce((a, c) => a + c.amount, 0),
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
      }))}
      contracts={customer.contracts.map((c) => ({
        id: c.id,
        amount: c.amount,
        signedAt: c.signedAt.toISOString(),
        remark: c.remark,
      }))}
      opportunities={customer.opportunities.map((o) => ({
        id: o.id,
        name: o.name,
        amount: o.amount,
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
      }))}
    />
  );
}
