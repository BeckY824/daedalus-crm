import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import CustomersView from "./CustomersView";
import type { Prisma } from "@/generated/prisma";
import { 可担任负责人 } from "@/lib/constants";

export const dynamic = "force-dynamic";

type SP = Promise<{
  keyword?: string;
  grade?: string;
  followStatus?: string;
  decisionStatus?: string;
  salesOwnerId?: string;
  channelOwnerId?: string;
  page?: string;
  pageSize?: string;
}>;

export default async function CustomersPage({ searchParams }: { searchParams: SP }) {
  await requireUser();
  const sp = await searchParams;

  const page = Math.max(1, Number(sp.page ?? 1));
  const pageSize = Math.min(100, Math.max(10, Number(sp.pageSize ?? 20)));

  const where: Prisma.CustomerWhereInput = {
    ...(sp.keyword
      ? {
          OR: [
            { name: { contains: sp.keyword } },
            { phone: { contains: sp.keyword } },
            { school: { contains: sp.keyword } },
            { major: { contains: sp.keyword } },
          ],
        }
      : {}),
    ...(sp.grade ? { grade: sp.grade } : {}),
    ...(sp.followStatus ? { followStatus: sp.followStatus } : {}),
    ...(sp.decisionStatus ? { decisionStatus: sp.decisionStatus } : {}),
    ...(sp.salesOwnerId ? { salesOwnerId: sp.salesOwnerId } : {}),
    ...(sp.channelOwnerId ? { channelOwnerId: sp.channelOwnerId } : {}),
  };

  const [rows, total, users, channels, allCustomers] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, name: true, phone: true, school: true, grade: true, major: true,
        followStatus: true, decisionStatus: true, expectedSignAt: true, lastFollowAt: true,
        remark: true, referrerCustomerId: true, channelId: true, salesOwnerId: true,
        updatedAt: true,
        salesOwner: { select: { name: true } },
        channelOwner: { select: { name: true } },
        channel: { select: { name: true } },
        referrerCustomer: { select: { name: true } },
        attributionChannel: { select: { name: true } },
        attributionCustomer: { select: { name: true } },
        contracts: { select: { amount: true } },
      },
    }),
    prisma.customer.count({ where }),
    prisma.user.findMany({ where: 可担任负责人, select: { id: true, name: true, email: true }, orderBy: { name: "asc" } }),
    prisma.channel.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.customer.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <CustomersView
      rows={rows.map((r) => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        school: r.school,
        grade: r.grade,
        major: r.major,
        followStatus: r.followStatus,
        decisionStatus: r.decisionStatus,
        expectedSignAt: r.expectedSignAt?.toISOString() ?? null,
        lastFollowAt: r.lastFollowAt?.toISOString() ?? null,
        remark: r.remark,
        referrerCustomerId: r.referrerCustomerId,
        channelId: r.channelId,
        // 推荐人可能是渠道，也可能是已有学员
        referrerName: r.referrerCustomer?.name ?? r.channel?.name ?? null,
        // 渠道归属：往上两代的计算结果
        attributionName: r.attributionChannel?.name ?? r.attributionCustomer?.name ?? null,
        channelOwnerName: r.channelOwner?.name ?? null,
        salesOwnerId: r.salesOwnerId,
        salesOwnerName: r.salesOwner.name,
        signedAmount: r.contracts.reduce((s, c) => s + c.amount, 0),
        // 并发闸门：编辑框拿它作为「我看到的是哪一版」
        updatedAt: r.updatedAt.toISOString(),
      }))}
      total={total}
      page={page}
      pageSize={pageSize}
      users={users}
      channels={channels}
      customers={allCustomers}
      filters={{
        keyword: sp.keyword ?? "",
        grade: sp.grade ?? "",
        followStatus: sp.followStatus ?? "",
        decisionStatus: sp.decisionStatus ?? "",
        salesOwnerId: sp.salesOwnerId ?? "",
        channelOwnerId: sp.channelOwnerId ?? "",
      }}
    />
  );
}
