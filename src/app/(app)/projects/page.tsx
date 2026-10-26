import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { 搜索词 } from "@/lib/search-keyword";
import { 负责人候选 } from "@/lib/owners";
import { 看板分列, type 项目行 } from "@/lib/project/board";
import { 看得到的客户, 露客户, 公海超时收回, 待我回的邀请 } from "@/lib/project/db";
import ProjectsView from "./ProjectsView";

export const dynamic = "force-dynamic";

/** 项目模式关着时这一页不存在（404），侧栏也没有入口。见 设计-团队版项目模式1a 第三节 */
export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ keyword?: string; ownerId?: string; pool?: string }> }) {
  const me = await requireUser();
  if ((await getBusiness()).projectMode !== true) notFound();
  // 企业版超时回收：先收再列，列表里看到的就是收完的样子
  await 公海超时收回(me).catch((e) => console.error("[超时回收] 扫的时候出错，这次先不收", e));
  const sp = await searchParams;
  const 词 = 搜索词(sp.keyword);
  const rows = await prisma.project.findMany({
    where: {
      ...(词 ? { OR: [{ name: { contains: 词 } }, { customer: { name: { contains: 词 } } }] } : {}),
      ...(typeof sp.ownerId === "string" && sp.ownerId ? { ownerId: sp.ownerId } : {}),
      ...(sp.pool === "1" ? { pooledAt: { not: null } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 500,
    include: { customer: { select: { name: true } }, exceptionCategory: { select: { name: true } } },
  });
  const [人, users, 可见, 邀请] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.ownerId))] } }, select: { id: true, name: true } }),
    负责人候选(),
    看得到的客户(rows.map((r) => r.customerId)),
    待我回的邀请(me),
  ]);
  const 名字 = new Map(人.map((u) => [u.id, u.name]));
  // 公海里同事客户的项目：不露客户名；按客户名搜也不该搜出它（否则等于拿名字试出来）
  const 露 = (p: (typeof rows)[number]) => 露客户(me, p, 可见);
  const 行: 项目行[] = rows.filter((p) => !词 || p.name.toLowerCase().includes(词.toLowerCase()) || 露(p)).map((p) => ({
    id: p.id, name: p.name, customerId: p.customerId, customerName: 露(p) ? p.customer.name : null,
    ownerId: p.ownerId, ownerName: 名字.get(p.ownerId) ?? "已不在的成员",
    phase: p.phase, node: p.node, result: p.result, exceptionCategory: p.exceptionCategory?.name ?? null, exceptionReason: p.exceptionReason,
    pooled: !!p.pooledAt,
    amount: p.amount, currency: p.currency, updatedAt: p.updatedAt.toISOString(),
  }));
  return (
    <ProjectsView
      行={行}
      列={看板分列(行)}
      取到上限={rows.length >= 500}
      users={users}
      邀请们={邀请.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))}
      filters={{ keyword: 词, ownerId: typeof sp.ownerId === "string" ? sp.ownerId : "", pool: sp.pool === "1" ? "1" : "" }}
    />
  );
}
