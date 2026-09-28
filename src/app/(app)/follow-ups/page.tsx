import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import FollowUpsView from "./FollowUpsView";
import type { Prisma } from "@/generated/prisma";
import { 负责人候选 } from "@/lib/owners";
import { 带过来的客户 } from "@/lib/options";
import { llmEnabled } from "@/lib/llm";

export const dynamic = "force-dynamic";

export default async function FollowUpsPage({
  searchParams,
}: {
  /** customer：从某位客户带过来的，「记录跟进」预填他；new=1：进来就把框打开 */
  searchParams: Promise<{ keyword?: string; type?: string; ownerId?: string; customer?: string; new?: string }>;
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

  const [总数, rows, users, 预选客户, aiEnabled] = await Promise.all([
    // take: 300 取回来的行数不是总数，分页条会拿它冒充总数。见 leads/page.tsx 的说明
    prisma.followUp.count({ where }),
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
    带过来的客户(sp.customer),
    // 「记录跟进」框里的 AI 速记和记录页同一个开关
    llmEnabled(),
  ]);

  return (
    <FollowUpsView
      总数={总数}
      预选客户={预选客户}
      直接新建={sp.new === "1"}
      aiEnabled={aiEnabled}
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
