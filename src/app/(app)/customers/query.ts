import { scheduleValue } from "@/lib/schedule-date";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import { dayjs } from "@/lib/utils";
import { 带币种, 签约金额, 签约合计, 签约币种 } from "@/lib/money-db";
import { 客户关键词条件, 客户id集合 } from "@/lib/search-keyword";
import { 取档案 } from "@/lib/customer-extra-db";

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
  /** 「1」= 只看公海里的（第 6 块） */
  pool?: string;
  /** 外贸档案的国家 / 来源（2026-10-05） */
  country?: string;
  source?: string;
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

  const keyword = await 客户关键词条件(sp.keyword);

  return {
    AND: [keyword, ...(本批 ? [客户id集合(本批.map(r => r.customerId))] : [])],
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
    ...(sp.pool === "1" ? { pool: { isNot: null } } : {}),
    ...(sp.country || sp.source
      ? { extra: { is: { ...(sp.country ? { country: sp.country } : {}), ...(sp.source ? { source: sp.source } : {}) } } }
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
  expectedSignOn: true,
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
  contracts: { select: { amount: true, ...带币种.签约 } },
  pool: { select: { reason: true } },
  extra: true,
} satisfies Prisma.CustomerSelect;

type 取到的行 = Prisma.CustomerGetPayload<{ select: typeof 客户行字段 }>;

/** 全范围按一种币种排序，再取页。扫描不带档案正文，避免把整库完整行交给浏览器。 */
export async function 客户金额分页(where: Prisma.CustomerWhereInput, order: "amount-asc" | "amount-desc", currency: string, page: number, pageSize: number): Promise<取到的行[]> {
  const amounts: { id: string; amount: number; createdAt: number }[] = [];
  let after: string | undefined;
  for (;;) {
    const batch = await prisma.customer.findMany({
      where: after ? { AND: [where, { id: { gt: after } }] } : where,
      orderBy: { id: "asc" }, take: 1000,
      select: { id: true, createdAt: true, contracts: { select: { amount: true, ...带币种.签约 } } },
    });
    for (const row of batch) amounts.push({ id: row.id, createdAt: row.createdAt.getTime(), amount: row.contracts.reduce((sum, c) => sum + (签约币种(c) === currency ? 签约金额(c) : 0), 0) });
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].id;
  }
  const direction = order === "amount-asc" ? 1 : -1;
  amounts.sort((a, b) => direction * (a.amount - b.amount) || b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const ids = amounts.slice((page - 1) * pageSize, page * pageSize).map(row => row.id);
  if (!ids.length) return [];
  const rows = await prisma.customer.findMany({ where: { AND: [where, { id: { in: ids } }] }, select: 客户行字段 });
  const positions = new Map(ids.map((id, index) => [id, index]));
  return rows.sort((a, b) => positions.get(a.id)! - positions.get(b.id)!);
}

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
    expectedSignAt: scheduleValue(r.expectedSignAt, r.expectedSignOn),
    lastFollowAt: r.lastFollowAt?.toISOString() ?? null,
    remark: r.remark,
    referrerCustomerId: r.referrerCustomerId,
    channelId: r.channelId,
    channelName: r.channel?.name ?? null,
    // 推荐人可能是渠道，也可能是已有学员
    referrerName: r.referrerCustomer?.name ?? r.channel?.name ?? null,
    // 渠道归属：往上两代的计算结果
    attributionName:
      r.attributionChannel?.name ?? r.attributionCustomer?.name ?? null,
    channelOwnerId: r.channelOwnerId,
    channelOwnerName: r.channelOwner?.name ?? null,
    salesOwnerId: r.salesOwnerId,
    salesOwnerName: r.salesOwner.name,
    signedAmount: r.contracts.reduce((s, c) => s + 签约金额(c), 0),
    signedTotals: 签约合计(r.contracts),
    /** 在公海里：负责人那一格写「公海（原 X）」，行上能领取。null = 不在 */
    pool: r.pool ? { reason: r.pool.reason } : null,
    /** 外贸档案：国家、WhatsApp、微信、邮箱、来源（2026-10-05） */
    // WhatsApp 也是号码：共享试用区和电话一样打码
    extra: (() => { const x = 取档案(r.extra); return { ...x, whatsapp: x.whatsapp && 号(x.whatsapp) }; })(),
    // 并发闸门：编辑框拿它作为「我看到的是哪一版」
    updatedAt: r.updatedAt.toISOString(),
  };
}

export type 客户行 = ReturnType<typeof 成客户行>;
