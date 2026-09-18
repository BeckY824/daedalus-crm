import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import FollowUpsView from "./FollowUpsView";
import type { Prisma } from "@/generated/prisma";
import { 负责人候选 } from "@/lib/owners";

export const dynamic = "force-dynamic";

export default async function FollowUpsPage({
  searchParams,
}: {
  searchParams: Promise<{ keyword?: string; type?: string; ownerId?: string }>;
}) {
  await requireUser();
  const sp = await searchParams;

  const where: Prisma.FollowUpWhereInput = {
    ...(sp.keyword
      ? {
          OR: [
            { title: { contains: sp.keyword } },
            { content: { contains: sp.keyword } },
            { customer: { name: { contains: sp.keyword } } },
          ],
        }
      : {}),
    ...(sp.type ? { type: sp.type } : {}),
    ...(sp.ownerId ? { ownerId: sp.ownerId } : {}),
  };

  const [rows, users] = await Promise.all([
    prisma.followUp.findMany({
      where,
      orderBy: { occurredAt: "desc" },
      take: 300,
      include: {
        customer: { select: { id: true, name: true } },
        owner: { select: { name: true } },
        contact: { select: { name: true } },
      },
    }),
    // 这是「按成员筛选」那个下拉。单人工作区里记录全在管理员名下，用严格口径会筛不出自己
    负责人候选(),
  ]);

  return (
    <FollowUpsView
      users={users}
      filters={{ keyword: sp.keyword ?? "", type: sp.type ?? "", ownerId: sp.ownerId ?? "" }}
      rows={rows.map((f) => ({
        id: f.id,
        type: f.type,
        title: f.title,
        content: f.content,
        status: f.status,
        duration: f.duration,
        occurredAt: f.occurredAt.toISOString(),
        customerId: f.customer.id,
        customerName: f.customer.name,
        contactName: f.contact?.name ?? null,
        ownerName: f.owner.name,
      }))}
    />
  );
}
