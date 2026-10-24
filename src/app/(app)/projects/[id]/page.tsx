import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { 能管项目, 角色字典, 异常类别字典, 能进公海的阶段, 看得到的客户, 露客户 } from "@/lib/project/db";
import { 负责人候选 } from "@/lib/owners";
import { 企业版 } from "@/lib/enterprise/switch";
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
      contact: { select: { id: true, name: true, position: true } },
      exceptionCategory: { select: { name: true } },
      logs: { orderBy: { at: "desc" }, take: 200 },
      members: { orderBy: { createdAt: "asc" } },
      followUps: { include: { followUp: { select: { id: true, type: true, content: true, occurredAt: true, ownerId: true } } } },
      _count: { select: { logs: true } },
    },
  });
  if (!p) notFound();
  const 能改 = 能管项目(me, p);
  // 公海里同事客户的项目：只给项目本身，客户、联系人、沟通内容领了再看（lib/project/db.ts 露客户）
  const 露 = 露客户(me, p, await 看得到的客户([p.customerId]));
  const [候选, 在职, 联系人们, 角色们, 类别们, 放回过] = await Promise.all([
    负责人候选(),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true, email: true }, orderBy: { name: "asc" } }),
    能改 ? prisma.contact.findMany({ where: { customerId: p.customerId }, select: { id: true, name: true, position: true }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] }) : [],
    角色字典(),
    异常类别字典(),
    // 历史负责人（企业版才显示）：放回过公海的人。单独查，不受上面节点变更只取 200 行的限
    !企业版() ? [] : prisma.projectNodeLog.findMany({ where: { projectId: p.id, kind: "pool-release" }, orderBy: { at: "desc" }, select: { fromOwnerId: true } }),
  ]);
  const 类别名 = new Map(类别们.map((c) => [c.id, c.name]));
  const 公海 = !!p.pooledAt;
  const 企业 = 企业版();

  const 历史负责人 = [...new Set(放回过.map((l) => l.fromOwnerId).filter((x): x is string => !!x))];
  const 人id = new Set<string>([...历史负责人, p.ownerId, p.creatorId, ...p.members.map((m) => m.userId), ...p.logs.flatMap((l) => [l.userId, l.fromOwnerId, l.toOwnerId].filter((x): x is string => !!x)), ...(露 ? p.followUps.map((f) => f.followUp.ownerId) : [])]);
  for (const x of [p.balanceSettledById, p.acceptancePassedById]) if (x) 人id.add(x);
  const 人 = await prisma.user.findMany({ where: { id: { in: [...人id] } }, select: { id: true, name: true } });
  const 名 = new Map(人.map((u) => [u.id, u.name]));
  const 叫 = (uid: string | null) => (uid ? 名.get(uid) ?? "已不在的成员" : null);

  const 详情: 项目详情 = {
    id: p.id, name: p.name, remark: p.remark, amount: p.amount, currency: p.currency,
    customer: 露 ? p.customer : null, contact: 露 ? p.contact : null,
    ownerId: p.ownerId, ownerName: 叫(p.ownerId)!, historyOwners: 历史负责人.map((x) => 叫(x)!), creatorName: 叫(p.creatorId)!, createdAt: p.createdAt.toISOString(),
    phase: p.phase, node: p.node, result: p.result, exceptionReason: p.exceptionReason, exceptionCategory: p.exceptionCategory?.name ?? null,
    pooled: 公海, 企业版: 企业,
    能放公海: !公海 && me.id === p.ownerId && (能进公海的阶段 as readonly string[]).includes(p.phase),
    // 企业版里放回去的那位也能领回；别的版本照旧不能自己领回
    能领取: 公海 && (企业 || me.id !== p.ownerId),
    balanceSettled: p.balanceSettled, balanceSettledBy: 叫(p.balanceSettledById), balanceSettledAt: p.balanceSettledAt?.toISOString() ?? null,
    acceptancePassed: p.acceptancePassed, acceptancePassedBy: 叫(p.acceptancePassedById), acceptancePassedAt: p.acceptancePassedAt?.toISOString() ?? null,
    logs: p.logs.map((l) => ({
      id: l.id, at: l.at.toISOString(), who: 叫(l.userId)!,
      from: l.fromNode ? { phase: l.fromPhase ?? "", node: l.fromNode, result: l.fromResult } : null,
      to: { phase: l.toPhase, node: l.toNode, result: l.toResult }, reason: l.reason,
      category: l.categoryId ? 类别名.get(l.categoryId) ?? "已不在的类别" : null,
      kind: l.kind === "transfer" || l.kind === "pool-release" || l.kind === "pool-claim" ? l.kind : "node",
      transfer: l.kind === "node" ? null : { from: 叫(l.fromOwnerId) ?? "没人", to: 叫(l.toOwnerId) ?? "没人" },
    })),
    followUps: (露 ? p.followUps : [])
      .map((f) => ({ id: f.followUp.id, type: f.followUp.type, content: f.followUp.content, occurredAt: f.followUp.occurredAt.toISOString(), who: 叫(f.followUp.ownerId)!, node: f.node }))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
    members: p.members.map((m) => ({ id: m.id, userId: m.userId, name: 叫(m.userId)!, roleId: m.roleId, inviteStatus: m.inviteStatus })),
    删前清点: { 留痕: p._count.logs, 组员: p.members.length, 沟通: p.followUps.length },
  };
  return <ProjectDetail p={详情} 能改={能改} 候选={候选} 在职={在职} 联系人们={联系人们} 角色们={角色们.map((r) => ({ id: r.id, name: r.name, active: r.active }))} 类别们={类别们.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name }))} />;
}
