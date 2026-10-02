import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import { dayjs } from "@/lib/utils";

/**
 * 客户列表的查询条件、取哪些字段、怎么变成一行——列表页和「导出」共用这一份（2026-10-02 排查）。
 * 原来导出拿的是当前这一页的 rows（默认 20 条），文件名却像整张表；拆出来以后导出按同样的条件取全部。
 */

export type 客户条件 = {
  keyword?: string;
  grade?: string;
  followStatus?: string;
  decisionStatus?: string;
  salesOwnerId?: string;
  channelOwnerId?: string;
  createdWithin?: string;
  directOf?: string;
  batch?: string;
};

export async function 客户筛选条件(
  sp: 客户条件,
): Promise<Prisma.CustomerWhereInput> {
  // 这一批导入动过的人。撤销过的批次不算（那些人已经删了 / 还原了）
  const 本批 = sp.batch
    ? await prisma.importRow.findMany({
        where: { batchId: sp.batch, batch: { revertedAt: null } },
        select: { customerId: true },
      })
    : null;

  return {
    ...(本批 ? { id: { in: 本批.map((r) => r.customerId) } } : {}),
    ...(sp.keyword
      ? {
          OR: [
            { name: { contains: sp.keyword } },
            { phone: { contains: sp.keyword } },
            { school: { contains: sp.keyword } },
            { major: { contains: sp.keyword } },
            // 年级、备注也搜，和 AI 的 search_customers 一个范围（排查 C7）：AI 说「大三的有 12 位」，点「去库里搜」不能是 0 条
            { grade: { contains: sp.keyword } },
            { remark: { contains: sp.keyword } },
          ],
        }
      : {}),
    ...(sp.grade ? { grade: sp.grade } : {}),
    ...(sp.followStatus ? { followStatus: sp.followStatus } : {}),
    ...(sp.decisionStatus ? { decisionStatus: sp.decisionStatus } : {}),
    ...(sp.salesOwnerId ? { salesOwnerId: sp.salesOwnerId } : {}),
    ...(sp.channelOwnerId ? { channelOwnerId: sp.channelOwnerId } : {}),
    ...(sp.createdWithin === "本月"
      ? { createdAt: { gte: dayjs().startOf("month").toDate() } }
      : {}),
    /*
    渠道页「直接推荐 5 人」点进来：渠道对得上、且没有上游学员，和 渠道汇总() 的 directCustomers 一个口径。
    原来链接用 keyword=渠道名，而关键词不搜渠道，点进去基本是 0 条（2026-10-01 排查 C1）
  */
    ...(sp.directOf
      ? { channelId: sp.directOf, referrerCustomerId: null }
      : {}),
  };
}

export const 客户行字段 = {
  id: true,
  name: true,
  phone: true,
  school: true,
  grade: true,
  major: true,
  followStatus: true,
  decisionStatus: true,
  expectedSignAt: true,
  lastFollowAt: true,
  remark: true,
  referrerCustomerId: true,
  channelId: true,
  salesOwnerId: true,
  channelOwnerId: true,
  updatedAt: true,
  salesOwner: { select: { name: true } },
  channelOwner: { select: { name: true } },
  channel: { select: { name: true } },
  referrerCustomer: { select: { name: true } },
  attributionChannel: { select: { name: true } },
  attributionCustomer: { select: { name: true } },
  contracts: { select: { amount: true } },
} satisfies Prisma.CustomerSelect;

type 取到的行 = Prisma.CustomerGetPayload<{ select: typeof 客户行字段 }>;

export function 成客户行(r: 取到的行, 号: (p: string) => string) {
  return {
    id: r.id,
    name: r.name,
    phone: 号(r.phone),
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
    attributionName:
      r.attributionChannel?.name ?? r.attributionCustomer?.name ?? null,
    channelOwnerId: r.channelOwnerId,
    channelOwnerName: r.channelOwner?.name ?? null,
    salesOwnerId: r.salesOwnerId,
    salesOwnerName: r.salesOwner.name,
    signedAmount: r.contracts.reduce((s, c) => s + c.amount, 0),
    // 并发闸门：编辑框拿它作为「我看到的是哪一版」
    updatedAt: r.updatedAt.toISOString(),
  };
}

export type 客户行 = ReturnType<typeof 成客户行>;
