/**
 * 盯盘清单的取数：从库里捞出三类原料，交给 sentinel.ts 的纯规则打分。
 * 首页（AI 对话的建议 chip）和数据看板（盯盘卡片）共用，避免两处各写一遍查询。
 */
import { prisma } from "./prisma";
import { dayjs } from "./utils";
import { buildWatchlist, type WatchItem } from "./sentinel";
import { getBusiness } from "./business";
import { statusLabel } from "./business-config";

export async function loadWatchlist(now = dayjs()): Promise<WatchItem[]> {
  const [overduePlans, customers, opps, business] = await Promise.all([
    prisma.followPlan.findMany({
      where: { done: false, plannedAt: { lt: now.toDate() } },
      select: { subject: true, plannedAt: true, customer: { select: { id: true, name: true } }, owner: { select: { name: true } } },
    }),
    prisma.customer.findMany({
      where: { followStatus: { notIn: ["已签约", "已流失", "暂缓跟进"] } },
      select: { id: true, name: true, followStatus: true, lastFollowAt: true, createdAt: true, salesOwner: { select: { name: true } } },
    }),
    prisma.opportunity.findMany({
      where: { status: "OPEN" },
      select: { name: true, stage: true, updatedAt: true, customer: { select: { id: true, name: true } }, owner: { select: { name: true } } },
    }),
    getBusiness(),
  ]);
  return buildWatchlist(
    {
      overduePlans: overduePlans.map((p) => ({ customerId: p.customer.id, customerName: p.customer.name, ownerName: p.owner.name, subject: p.subject, plannedAt: p.plannedAt })),
      customers: customers.map((c) => ({ id: c.id, name: c.name, followStatus: c.followStatus, lastFollowAt: c.lastFollowAt, createdAt: c.createdAt, ownerName: c.salesOwner.name })),
      opportunities: opps.map((o) => ({ customerId: o.customer.id, customerName: o.customer.name, ownerName: o.owner.name, name: o.name, stage: o.stage, updatedAt: o.updatedAt })),
    },
    now.toDate(),
    business.customer,
    (v) => statusLabel(business, v),
  );
}
