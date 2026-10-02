"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { 号码脱敏器 } from "@/lib/shared-ws/current";
import { 客户筛选条件, 客户行字段, 成客户行, type 客户条件, type 客户行 } from "./query";

/** 一次最多导这么多行。再多就该分批筛了，也免得一次查询把桌面端的库攥住太久 */
const 导出上限 = 20_000;

/**
 * 「导出」：按列表眼下的筛选条件取**全部**，不是当前这一页（2026-10-02 排查）。
 * 号码照样过 号码脱敏器（共享试用区打码），和列表上看到的一致。
 */
export async function 导出客户(条件: 客户条件): Promise<{ ok: true; rows: 客户行[]; 截断了: boolean } | { ok: false; error: string }> {
  await requireUser();
  const where = await 客户筛选条件(条件);
  const [rows, 号] = await Promise.all([
    prisma.customer.findMany({ where, orderBy: { createdAt: "desc" }, take: 导出上限 + 1, select: 客户行字段 }),
    号码脱敏器(),
  ]);
  return { ok: true, rows: rows.slice(0, 导出上限).map((r) => 成客户行(r, 号)), 截断了: rows.length > 导出上限 };
}
