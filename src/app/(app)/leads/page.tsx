import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import LeadsView from "./LeadsView";
import type { Prisma } from "@/generated/prisma";
import { 负责人候选 } from "@/lib/owners";

export const dynamic = "force-dynamic";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ keyword?: string; status?: string }>;
}) {
  const me = await requireUser();
  const sp = await searchParams;

  const where: Prisma.LeadWhereInput = {
    ...(sp.keyword
      ? { OR: [{ name: { contains: sp.keyword } }, { contact: { contains: sp.keyword } }] }
      : {}),
    ...(sp.status ? { status: sp.status } : {}),
  };

  const [rows, users] = await Promise.all([
    prisma.lead.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 300,
      include: { owner: { select: { name: true } } },
    }),
    负责人候选(),
  ]);
  /**
   * 新建线索默认归「我」（LeadsView 里 ownerId: me）。我不在候选名单里时——桌面端单人用，
   * 你就是管理员，灌了演示数据之后名单里只剩那四个销售——下拉会显示成一串 id
   * （2026-09-17 在真机上看到的就是 `cmu58lup…`），编辑一条归管理员的线索也是同样的显示。
   * 服务端本来就收管理员当负责人，所以把我补进名单只是让它显示成名字。
   * 这一页原来直接查 可担任负责人 而不是走 负责人候选()，连单人工作区那条回退都没有。
   */
  const 候选 = users.some((u) => u.id === me.id) ? users : [...users, { id: me.id, name: me.name, email: me.email }];

  return (
    <LeadsView
      me={me.id}
      users={候选}
      filters={{ keyword: sp.keyword ?? "", status: sp.status ?? "" }}
      rows={rows.map((l) => ({
        id: l.id,
        name: l.name,
        contact: l.contact,
        phone: l.phone,
        email: l.email,
        industry: l.industry,
        source: l.source,
        status: l.status,
        remark: l.remark,
        ownerId: l.ownerId,
        ownerName: l.owner?.name ?? "—",
        customerId: l.customerId,
        createdAt: l.createdAt.toISOString(),
      }))}
    />
  );
}
