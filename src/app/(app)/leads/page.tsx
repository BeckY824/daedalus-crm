import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import LeadsView from "./LeadsView";
import type { Prisma } from "@/generated/prisma";
import { 可担任负责人 } from "@/lib/constants";

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
    prisma.user.findMany({ where: 可担任负责人, select: { id: true, name: true, email: true } }),
  ]);

  return (
    <LeadsView
      me={me.id}
      users={users}
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
