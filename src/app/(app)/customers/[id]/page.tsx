import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import CustomerDetailView from "./CustomerDetailView";
import { 可担任负责人 } from "@/lib/constants";
import { llmEnabled } from "@/lib/llm";

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
        },
      },
    },
  });

  if (!customer) notFound();

  const [users, channels, referrableCustomers] = await Promise.all([
    prisma.user.findMany({ where: 可担任负责人, select: { id: true, name: true, email: true }, orderBy: { name: "asc" } }),
    prisma.channel.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    // 排除自己，避免把自己设为推荐人导致推荐链成环
    prisma.customer.findMany({ where: { id: { not: id } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  // 沟通统计
  const stats = {
    followCount: customer.followUps.length,
    callSeconds: customer.followUps
      .filter((f) => f.type === "PHONE")
      .reduce((s, f) => s + (f.duration ?? 0), 0),
    meetingCount: customer.followUps.filter((f) => f.type === "MEETING").length,
    emailCount: customer.followUps.filter((f) => f.type === "EMAIL").length,
  };

  return (
    <CustomerDetailView
      users={users}
      channels={channels}
      referrableCustomers={referrableCustomers}
      stats={stats}
      aiEnabled={llmEnabled()}
      customer={{
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
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
        phone: c.phone,
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
        attachment: f.attachment,
        attachSize: f.attachSize,
        participants: f.participants,
        ownerName: f.owner.name,
        contactName: f.contact?.name ?? null,
        contactPosition: f.contact?.position ?? null,
        contactId: f.contactId,
        opportunityId: f.opportunityId,
      }))}
    />
  );
}
