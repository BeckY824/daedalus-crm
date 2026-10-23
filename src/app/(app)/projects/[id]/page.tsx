import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { 能管项目 } from "@/lib/project/db";
import ProjectDetail, { type 项目详情 } from "./ProjectDetail";

export const dynamic = "force-dynamic";

/** 项目详情（团队版项目模式 1a）：改节点、勾尾款 / 验收、节点变更和挂在项目上的沟通。开关关着时不存在 */
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  if ((await getBusiness()).projectMode !== true) notFound();
  const { id } = await params;
  const p = await prisma.project.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, name: true, school: true } },
      contact: { select: { id: true, name: true, position: true, phone: true } },
      logs: { orderBy: { at: "desc" }, take: 200 },
      followUps: { include: { followUp: { select: { id: true, type: true, content: true, occurredAt: true, ownerId: true } } } },
    },
  });
  if (!p) notFound();

  const 人id = new Set<string>([p.ownerId, p.creatorId, ...p.logs.map((l) => l.userId), ...p.followUps.map((f) => f.followUp.ownerId)]);
  for (const x of [p.balanceSettledById, p.acceptancePassedById]) if (x) 人id.add(x);
  const 人 = await prisma.user.findMany({ where: { id: { in: [...人id] } }, select: { id: true, name: true } });
  const 名 = new Map(人.map((u) => [u.id, u.name]));
  const 叫 = (uid: string | null) => (uid ? 名.get(uid) ?? "已不在的成员" : null);

  const 详情: 项目详情 = {
    id: p.id, name: p.name, remark: p.remark, amount: p.amount, currency: p.currency,
    customer: p.customer, contact: p.contact,
    ownerName: 叫(p.ownerId)!, creatorName: 叫(p.creatorId)!, createdAt: p.createdAt.toISOString(),
    phase: p.phase, node: p.node, result: p.result, exceptionReason: p.exceptionReason,
    balanceSettled: p.balanceSettled, balanceSettledBy: 叫(p.balanceSettledById), balanceSettledAt: p.balanceSettledAt?.toISOString() ?? null,
    acceptancePassed: p.acceptancePassed, acceptancePassedBy: 叫(p.acceptancePassedById), acceptancePassedAt: p.acceptancePassedAt?.toISOString() ?? null,
    logs: p.logs.map((l) => ({
      id: l.id, at: l.at.toISOString(), who: 叫(l.userId)!,
      from: l.fromNode ? { phase: l.fromPhase ?? "", node: l.fromNode, result: l.fromResult } : null,
      to: { phase: l.toPhase, node: l.toNode, result: l.toResult }, reason: l.reason,
    })),
    followUps: p.followUps
      .map((f) => ({ id: f.followUp.id, type: f.followUp.type, content: f.followUp.content, occurredAt: f.followUp.occurredAt.toISOString(), who: 叫(f.followUp.ownerId)!, node: f.node }))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
  };
  return <ProjectDetail p={详情} 能改={能管项目(me, p)} />;
}
