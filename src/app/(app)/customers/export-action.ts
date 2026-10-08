"use server";

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { 号码脱敏器 } from "@/lib/shared-ws/current";
import { 客户筛选条件, 客户行字段, 成客户行, type 客户条件, type 客户行 } from "./query";
import type { 跟进导出行 } from "./export-table";

/** 旧调用保留有明确截断标志的有界结果；产品按钮使用下面的完整分批出口。 */
const 导出上限 = 20_000;
const 跟进上限 = 50_000;

export async function 导出客户(条件: 客户条件): Promise<
  { ok: true; rows: 客户行[]; 跟进: 跟进导出行[]; 截断了: boolean; 跟进截断了: boolean } | { ok: false; error: string }
> {
  await requireUser();
  const where = await 客户筛选条件(条件);
  const [全部, 号] = await Promise.all([
    prisma.customer.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 导出上限 + 1, select: { ...客户行字段, createdAt: true } }),
    号码脱敏器(),
  ]);
  const rows = 全部.slice(0, 导出上限);
  /*
    这些客户的跟进记录（2026-10-05 外贸客户建议），一起放进同一个 Excel 的第二张表。
    按客户在列表里的顺序、每位里按时间先后排：在 Excel 里往下读就是一位一位的往来经过
  */
  const 顺序 = new Map(rows.map((r, i) => [r.id, i]));
  /*
    按客户的筛选条件查，不拼「customerId in 两万个 id」（SQLite 一条语句的参数有上限，复查）。
    新的在前取、超了截掉的是最老的那些；取回来再按客户、时间先后排
  */
  const 跟进行 = rows.length
    ? await prisma.followUp.findMany({
        where: { customer: { AND: [where, { OR: [
          { createdAt: { gt: rows.at(-1)!.createdAt } },
          { createdAt: rows.at(-1)!.createdAt, id: { gte: rows.at(-1)!.id } },
        ] }] } },
        orderBy: { occurredAt: "desc" },
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
    // 客户超了导出上限、没进第一张表的那几位，跟进也不带
    .filter((f) => 人.has(f.customerId))
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


/** 完整导出按固定顺序分批读取，每批请求独立检查当前权限。 */
export async function 开始完整导出(条件: 客户条件) {
  await requireUser();
  const 截止 = new Date();
  const where = { AND: [await 客户筛选条件(条件), { createdAt: { lte: 截止 } }] };
  const [客户数, 跟进数] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.followUp.count({ where: { customer: where, createdAt: { lte: 截止 } } }),
  ]);
  return { 截止: 截止.toISOString(), 客户数, 跟进数 };
}

export async function 读取完整导出批次(条件: 客户条件, 截止文本: string, 类别: "客户" | "跟进", 游标?: string) {
  await requireUser();
  const 截止 = new Date(截止文本);
  if (!Number.isFinite(截止.getTime()) || 截止 > new Date() || (类别 !== "客户" && 类别 !== "跟进") || (游标 !== undefined && (typeof 游标 !== "string" || 游标.length > 128))) throw new Error("导出参数无效，请重新导出");
  const where = { AND: [await 客户筛选条件(条件), { createdAt: { lte: 截止 } }] };
  const 号 = await 号码脱敏器();
  if (类别 === "客户") {
    const all = await prisma.customer.findMany({ where: { AND: [where, ...(游标 ? [{ id: { gt: 游标 } }] : [])] }, orderBy: { id: "asc" }, take: 5001, select: 客户行字段 });
    const rows = all.slice(0, 5000);
    const values = rows.map((r) => 成客户行(r, 号));
    return { 类别: "客户" as const, rows: values, 指纹: createHash("sha256").update(JSON.stringify(values)).digest("hex"), 游标: all.length > 5000 ? rows.at(-1)!.id : null };
  }
  const all = await prisma.followUp.findMany({
    where: { customer: where, createdAt: { lte: 截止 }, ...(游标 ? { id: { gt: 游标 } } : {}) },
    orderBy: { id: "asc" }, take: 10001,
    select: { id: true, customerId: true, customer: { select: { name: true, phone: true } }, occurredAt: true, type: true, title: true, content: true, status: true,
      opportunity: { select: { name: true } }, orderNode: { select: { order: { select: { no: true } } } }, owner: { select: { name: true } } },
  });
  const rows = all.slice(0, 10000);
  const values = rows.map((f) => ({ id: f.id, customerId: f.customerId, customerName: f.customer.name, phone: 号(f.customer.phone), occurredAt: f.occurredAt.toISOString(), type: f.type, title: f.title, content: f.content, status: f.status, opportunityName: f.opportunity?.name ?? null, orderNo: f.orderNode?.order.no ?? null, ownerName: f.owner.name }));
  return { 类别: "跟进" as const, rows: values, 指纹: createHash("sha256").update(JSON.stringify(values)).digest("hex"), 游标: all.length > 10000 ? rows.at(-1)!.id : null };
}

/** 导出期间发生相关写入/删除时不把分批结果冒充同一时刻的完整快照。 */
export async function 校验完整导出(条件: 客户条件, 起点: Awaited<ReturnType<typeof 开始完整导出>>, 指纹: { 类别: "客户" | "跟进"; 指纹: string }[]) {
  await requireUser();
  if (!起点 || typeof 起点.截止 !== "string" || !Number.isSafeInteger(起点.客户数) || 起点.客户数 < 0 || !Number.isSafeInteger(起点.跟进数) || 起点.跟进数 < 0 || !Array.isArray(指纹) || 指纹.some((x) => !x || (x.类别 !== "客户" && x.类别 !== "跟进") || !/^[a-f0-9]{64}$/.test(x.指纹))) throw new Error("导出参数无效，请重新导出");
  const 截止 = new Date(起点.截止);
  if (!Number.isFinite(截止.getTime()) || 截止 > new Date()) throw new Error("导出参数无效，请重新导出");
  const where = { AND: [await 客户筛选条件(条件), { createdAt: { lte: 截止 } }] };
  const [客户数, 跟进数, 改过客户, 改过跟进] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.followUp.count({ where: { customer: where, createdAt: { lte: 截止 } } }),
    prisma.customer.findFirst({ where: { createdAt: { lte: 截止 }, updatedAt: { gt: 截止 } }, select: { id: true } }),
    prisma.followUp.findFirst({ where: { createdAt: { lte: 截止 }, updatedAt: { gt: 截止 } }, select: { id: true } }),
  ]);
  if (客户数 !== 起点.客户数 || 跟进数 !== 起点.跟进数 || 改过客户 || 改过跟进) throw new Error("导出期间数据发生变化，请等待修改结束后重新导出；本次不会生成不完整文件");
  let index = 0;
  for (const 类别 of ["客户", "跟进"] as const) {
    let 游标: string | undefined;
    do {
      const r = await 读取完整导出批次(条件, 起点.截止, 类别, 游标);
      const before = 指纹[index++];
      if (!before || before.类别 !== 类别 || before.指纹 !== r.指纹) throw new Error("导出期间数据或权限发生变化，请重新导出；本次不会生成不完整文件");
      游标 = r.游标 ?? undefined;
    } while (游标);
  }
  if (index !== 指纹.length) throw new Error("导出批次不完整，请重新导出");
  return { ok: true as const };
}
