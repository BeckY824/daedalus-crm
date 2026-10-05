"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { 号码脱敏器 } from "@/lib/shared-ws/current";
import { 客户筛选条件, 客户行字段, 成客户行, type 客户条件, type 客户行 } from "./query";
import type { 跟进导出行 } from "./export-table";

/** 一次最多导这么多行。再多就该分批筛了，也免得一次查询把桌面端的库攥住太久 */
const 导出上限 = 20_000;
/** 跟进记录最多带这么多条（一张 Excel 表一百万行以内都打得开，这里按导出要快一点定） */
const 跟进上限 = 100_000;

/**
 * 「导出」：按列表眼下的筛选条件取**全部**，不是当前这一页（2026-10-02 排查）。
 * 号码照样过 号码脱敏器（共享试用区打码），和列表上看到的一致。
 */
export async function 导出客户(条件: 客户条件): Promise<
  { ok: true; rows: 客户行[]; 跟进: 跟进导出行[]; 截断了: boolean; 跟进截断了: boolean } | { ok: false; error: string }
> {
  await requireUser();
  const where = await 客户筛选条件(条件);
  const [全部, 号] = await Promise.all([
    prisma.customer.findMany({ where, orderBy: { createdAt: "desc" }, take: 导出上限 + 1, select: 客户行字段 }),
    号码脱敏器(),
  ]);
  const rows = 全部.slice(0, 导出上限);
  /*
    这些客户的跟进记录（2026-10-05 外贸客户建议），一起放进同一个 Excel 的第二张表。
    按客户在列表里的顺序、每位里按时间先后排：在 Excel 里往下读就是一位一位的往来经过
  */
  const 顺序 = new Map(rows.map((r, i) => [r.id, i]));
  const 跟进行 = rows.length
    ? await prisma.followUp.findMany({
        where: { customerId: { in: rows.map((r) => r.id) } },
        orderBy: { occurredAt: "asc" },
        take: 跟进上限 + 1,
        select: {
          customerId: true, occurredAt: true, type: true, title: true, content: true, status: true,
          opportunity: { select: { name: true } },
          orderNode: { select: { order: { select: { no: true } } } },
          owner: { select: { name: true } },
        },
      })
    : [];
  const 人 = new Map(rows.map((r) => [r.id, r]));
  const 跟进 = 跟进行
    .slice(0, 跟进上限)
    .sort((a, b) => (顺序.get(a.customerId) ?? 0) - (顺序.get(b.customerId) ?? 0) || a.occurredAt.getTime() - b.occurredAt.getTime())
    .map((f) => ({
      customerName: 人.get(f.customerId)?.name ?? "",
      phone: 号(人.get(f.customerId)?.phone ?? ""),
      occurredAt: f.occurredAt.toISOString(),
      type: f.type,
      title: f.title,
      content: f.content,
      status: f.status,
      opportunityName: f.opportunity?.name ?? null,
      orderNo: f.orderNode?.order.no ?? null,
      ownerName: f.owner.name,
    }));
  return { ok: true, rows: rows.map((r) => 成客户行(r, 号)), 跟进, 截断了: 全部.length > 导出上限, 跟进截断了: 跟进行.length > 跟进上限 };
}
