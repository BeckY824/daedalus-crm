/**
 * 客户外贸档案的读写（2026-10-05）。规则在 lib/customer-extra.ts。
 * 一位客户最多一行；没有这一行 = 都没填。全部清空也**不删行**、写成空（2026-10-05 复查）：删了再填是一条「插入」，
 * 团队同步里插入带着全部列，会把同事那边同时填的格子冲掉（lib/sync/local.ts 回放那条规矩只管插入撞已有行）
 */
import type { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import { 外贸键, 空档案, type 外贸档案 } from "./customer-extra";

type 库 = Prisma.TransactionClient | typeof prisma;

/**
 * 只改给了的那几格（undefined = 不碰，null = 清空）。
 * 默认顺带把客户的 updatedAt 往前推（2026-10-05 复查）：档案是客户的一部分，撤销导入靠 updatedAt 认「导入之后人改过没有」，
 * 不推的话人逐个补了 WhatsApp，一撤销整批照删。刚建出来的客户（新建、线索转客户、导入）不用推：传 碰版本 false
 */
export async function 写外贸档案(db: 库, customerId: string, 改: Partial<外贸档案>, 碰版本 = true): Promise<void> {
  const 有改 = 外贸键.filter((k) => 改[k] !== undefined);
  if (有改.length === 0) return;
  const 原 = await db.customerExtra.findUnique({ where: { customerId } });
  const 新: 外贸档案 = { ...空档案(), ...(原 ? 取档案(原) : {}) };
  for (const k of 有改) 新[k] = 改[k] ?? null;
  if (!原 && 外贸键.every((k) => !新[k])) return;
  await db.customerExtra.upsert({ where: { customerId }, create: { customerId, ...新 }, update: 新 });
  if (碰版本) await db.customer.update({ where: { id: customerId }, data: { updatedAt: new Date() } });
}

/** 库里那一行 → 五格（多余的列不带出去） */
export function 取档案(r: Partial<外贸档案> | null | undefined): 外贸档案 {
  const o = 空档案();
  if (!r) return o;
  for (const k of 外贸键) o[k] = r[k] ?? null;
  return o;
}
