/**
 * 客户外贸档案的读写（2026-10-05）。规则在 lib/customer-extra.ts。
 * 一位客户最多一行；全部清空就把那一行删掉（没有这一行 = 都没填，和从没填过一样）。
 */
import type { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import { 外贸键, 空档案, type 外贸档案 } from "./customer-extra";

type 库 = Prisma.TransactionClient | typeof prisma;

/** 只改给了的那几格（undefined = 不碰，null = 清空） */
export async function 写外贸档案(db: 库, customerId: string, 改: Partial<外贸档案>): Promise<void> {
  const 有改 = 外贸键.filter((k) => 改[k] !== undefined);
  if (有改.length === 0) return;
  const 原 = await db.customerExtra.findUnique({ where: { customerId } });
  const 新: 外贸档案 = { ...空档案(), ...(原 ? 取档案(原) : {}) };
  for (const k of 有改) 新[k] = 改[k] ?? null;
  if (外贸键.every((k) => !新[k])) {
    if (原) await db.customerExtra.delete({ where: { customerId } });
    return;
  }
  await db.customerExtra.upsert({ where: { customerId }, create: { customerId, ...新 }, update: 新 });
}

/** 库里那一行 → 五格（多余的列不带出去） */
export function 取档案(r: Partial<外贸档案> | null | undefined): 外贸档案 {
  const o = 空档案();
  if (!r) return o;
  for (const k of 外贸键) o[k] = r[k] ?? null;
  return o;
}
