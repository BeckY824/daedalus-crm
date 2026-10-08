"use server";

import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { followHistoryInclude, followHistoryOrder, serializeFollowHistory } from "./follow-history-query";

export type FollowHistoryCursor = { occurredAt: string; id: string };
const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 256;
const unavailable = { ok: false as const, error: "这位客户不存在或当前账号无权查看，请刷新确认" };

/** 使用不可变的排序边界，不依赖游标那条记录仍存在。所有查询继续经过租户/业务员限定。 */
export async function loadFollowHistory(customerId: string, before?: FollowHistoryCursor) {
  await requireUser();
  if (!validId(customerId)) return unavailable;
  if (before !== undefined && (!before || !validId(before.id) || typeof before.occurredAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(before.occurredAt)
    || !Number.isFinite(new Date(before.occurredAt).getTime()) || new Date(before.occurredAt).toISOString() !== before.occurredAt)) {
    return { ok: false as const, error: "历史记录页码已失效，请刷新记录" };
  }
  if (!await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } })) return unavailable;
  const rows = await prisma.followUp.findMany({
    where: { customerId, ...(before ? { OR: [
      { occurredAt: { lt: new Date(before.occurredAt) } },
      { occurredAt: new Date(before.occurredAt), id: { lt: before.id } },
    ] } : {}) },
    orderBy: followHistoryOrder, take: 51, include: followHistoryInclude,
  });
  return { ok: true as const, rows: rows.slice(0, 50).map(serializeFollowHistory), hasMore: rows.length > 50 };
}

/** 编辑/撤销旧页记录后只重读该条，不把整段历史下载回浏览器。 */
export async function readFollowHistoryRow(customerId: string, id: string) {
  await requireUser();
  if (!validId(customerId) || !validId(id)) return unavailable;
  if (!await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } })) return unavailable;
  const row = await prisma.followUp.findFirst({ where: { id, customerId }, include: followHistoryInclude });
  return { ok: true as const, row: row ? serializeFollowHistory(row) : null };
}
