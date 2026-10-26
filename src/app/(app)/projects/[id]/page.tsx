import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { 能管项目, 能改节点, 代管节点, 往前推不给, 直属才推, 角色字典, 异常类别字典, 能进公海的阶段, 看得到的客户, 露客户, 读必填数据 } from "@/lib/project/db";
import { 按必填走, 节点必填, 还差 } from "@/lib/project/required";
import { 负责人候选 } from "@/lib/owners";
import { 企业版 } from "@/lib/enterprise/switch";
import { 读组织 } from "@/lib/enterprise/org";
import { 生效组织规则 } from "@/lib/project/org-rules-store";
import { 超时回收日, 超时起点, 超时理由, 系统 } from "@/lib/project/timeout";
import { 停用项目进公海理由 } from "@/lib/offboard-db";
import { 拦原负责人, 原负责人不能领回提示 } from "@/lib/enterprise/pool-rules";
import { dayjs } from "@/lib/utils";
import ProjectDetail, { type 项目详情, type 放回方式 } from "./ProjectDetail";

export const dynamic = "force-dynamic";

/** 项目详情（团队版项目模式 1a）：改节点、勾尾款 / 验收、节点变更和挂在项目上的沟通。开关关着时不存在 */
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  if ((await getBusiness()).projectMode !== true) notFound();
  const { id } = await params;
  const p = await prisma.project.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, name: true, school: true, lastFollowAt: true } },
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
  const [候选, 在职, 联系人们, 角色们, 类别们, 放回过, 规则] = await Promise.all([
    负责人候选(),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true, email: true }, orderBy: { name: "asc" } }),
    能改 ? prisma.contact.findMany({ where: { customerId: p.customerId }, select: { id: true, name: true, position: true }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] }) : [],
    角色字典(),
    异常类别字典(),
    // 历史负责人（企业版才显示）：放回过公海的人。单独查，不受上面节点变更只取 200 行的限
    !企业版() ? [] : prisma.projectNodeLog.findMany({ where: { projectId: p.id, kind: "pool-release" }, orderBy: { at: "desc" }, select: { fromOwnerId: true } }),
    生效组织规则(),
  ]);
  const 类别名 = new Map(类别们.map((c) => [c.id, c.name]));
  const 公海 = !!p.pooledAt;
  const 企业 = 企业版();

  const 历史负责人 = [...new Set(放回过.map((l) => l.fromOwnerId).filter((x): x is string => !!x))];
  const 人id = new Set<string>([...历史负责人, p.ownerId, p.creatorId, ...p.members.map((m) => m.userId), ...p.logs.flatMap((l) => [l.userId, l.fromOwnerId, l.toOwnerId].filter((x): x is string => !!x)), ...(露 ? p.followUps.map((f) => f.followUp.ownerId) : [])]);
  for (const x of [p.balanceSettledById, p.acceptancePassedById]) if (x) 人id.add(x);
  const 人 = await prisma.user.findMany({ where: { id: { in: [...人id] } }, select: { id: true, name: true } });
  const 名 = new Map(人.map((u) => [u.id, u.name]));
  // 超时回收记在「系统」名下（timeout.ts 系统，QA #16），不是真成员
  const 叫 = (uid: string | null) => (uid ? (uid === 系统.id ? 系统.name : 名.get(uid) ?? "已不在的成员") : null);
  // 怎么进的公海：超时系统收的 / 办停用时放的（操作人是办的那位管理员，不是离职的人）/ 有人手动放回（QA #14）
  const 认放回 = (reason: string | null): 放回方式 => (reason === 超时理由 ? "超时" : reason === 停用项目进公海理由 ? "停用" : "手动");
  const 最近放回 = 公海 ? p.logs.find((l) => l.kind === "pool-release") : undefined;
  // 企业版「非原负责人均可领取」：原负责人看得到领取按钮、灰着（pool-rules.ts）
  const 原负责人领不回 = 公海 && me.id === p.ownerId && 拦原负责人();

  // 企业版超时回收：线索 / 商机阶段记沟通要填下一步时间；算出哪天会自动回公海（和 lib/project/db.ts 公海超时收回 同一个起点）
  const 要下一步 = 规则.超时回收.开 && !p.result && (能进公海的阶段 as readonly string[]).includes(p.phase);
  const 回收日 = 超时回收日(规则, p, 超时起点(p.createdAt, p.logs[0]?.at, p.customer.lastFollowAt));
  const 能记沟通 = 企业 && !公海 && (能改 || p.members.some((m) => m.userId === me.id && m.inviteStatus === "JOINED"));
  // 企业版节点必填：这个节点配了必填才给；还差哪几样和 lib/project/db.ts 按必填推进 同一个算法
  // 企业版 D-37：直属上级（账号可能还是 SALES）、总管理员能改节点；负责人有直属上级时往前推只给直属上级和老板（都和 lib/project/db.ts 改节点 同一个判断）
  const org = 企业 ? await 读组织() : null;
  const 节点能改 = 能改节点(me, p, org);
  const 必填 = !公海 && !p.result && 按必填走(规则, p.node)
    ? { 配了: 节点必填(规则, p.node), 还差: 还差(规则, await 读必填数据(prisma, p)), 只能靠填齐: me.role !== "ADMIN" && me.role !== "MANAGER" && !代管节点(me, p.ownerId, org) }
    : null;
  const 不给推 = 企业 && !公海 && !p.result ? 往前推不给(me, p.ownerId, await 直属才推(org)) : null;

  const 详情: 项目详情 = {
    id: p.id, name: p.name, remark: p.remark, amount: p.amount, currency: p.currency,
    customer: 露 ? { id: p.customer.id, name: p.customer.name, school: p.customer.school } : null, contact: 露 ? p.contact : null,
    ownerId: p.ownerId, ownerName: 叫(p.ownerId)!, historyOwners: 历史负责人.map((x) => 叫(x)!), creatorName: 叫(p.creatorId)!, createdAt: p.createdAt.toISOString(),
    phase: p.phase, node: p.node, result: p.result, exceptionReason: p.exceptionReason, exceptionCategory: p.exceptionCategory?.name ?? null,
    pooled: 公海, 企业版: 企业,
    // 下一步时间只有日子：在服务端按业务日排成 YYYY-MM-DD，和回收日同一个钟，浏览器在别的时区也不差一天
    nextStepAt: p.nextStepAt ? dayjs(p.nextStepAt).format("YYYY-MM-DD") : null, 回收日, 要下一步, 能记沟通, 必填, 不给推, 能改节点: 节点能改,
    能放公海: !公海 && me.id === p.ownerId && (能进公海的阶段 as readonly string[]).includes(p.phase),
    // 原负责人领不回（企业版按 pool-rules.ts，别的版本本来就不能自己领回）；企业版按钮灰着摆、别的版本照旧不摆
    能领取: 公海 && (企业 ? !原负责人领不回 : me.id !== p.ownerId),
    领取不给: 原负责人领不回 ? 原负责人不能领回提示 : null,
    进公海: 最近放回 ? { 方式: 认放回(最近放回.reason), 谁: 叫(最近放回.userId)! } : null,
    balanceSettled: p.balanceSettled, balanceSettledBy: 叫(p.balanceSettledById), balanceSettledAt: p.balanceSettledAt?.toISOString() ?? null,
    acceptancePassed: p.acceptancePassed, acceptancePassedBy: 叫(p.acceptancePassedById), acceptancePassedAt: p.acceptancePassedAt?.toISOString() ?? null,
    logs: p.logs.map((l) => ({
      id: l.id, at: l.at.toISOString(), who: 叫(l.userId)!,
      from: l.fromNode ? { phase: l.fromPhase ?? "", node: l.fromNode, result: l.fromResult } : null,
      to: { phase: l.toPhase, node: l.toNode, result: l.toResult }, reason: l.reason,
      category: l.categoryId ? 类别名.get(l.categoryId) ?? "已不在的类别" : null,
      kind: l.kind === "transfer" || l.kind === "pool-release" || l.kind === "pool-claim" ? l.kind : "node",
      transfer: l.kind === "node" ? null : { from: 叫(l.fromOwnerId) ?? "没人", to: 叫(l.toOwnerId) ?? "没人" },
      ...(l.kind === "pool-release" ? { 放回方式: 认放回(l.reason) } : {}),
    })),
    followUps: (露 ? p.followUps : [])
      .map((f) => ({ id: f.followUp.id, type: f.followUp.type, content: f.followUp.content, occurredAt: f.followUp.occurredAt.toISOString(), who: 叫(f.followUp.ownerId)!, node: f.node }))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
    members: p.members.map((m) => ({ id: m.id, userId: m.userId, name: 叫(m.userId)!, roleId: m.roleId, inviteStatus: m.inviteStatus })),
    删前清点: { 留痕: p._count.logs, 组员: p.members.length, 沟通: p.followUps.length },
  };
  return <ProjectDetail p={详情} 能改={能改} 候选={候选} 在职={在职} 联系人们={联系人们} 角色们={角色们.map((r) => ({ id: r.id, name: r.name, active: r.active }))} 类别们={类别们.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name }))} />;
}
