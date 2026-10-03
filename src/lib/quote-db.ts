/**
 * 报价明细的读写（2026-10-03 外贸第 3 块）。纯函数在 lib/quote.ts。
 *
 * 一次报价 = 一行 Quote + 若干 QuoteLine。**改价不覆盖**：保存商机时明细和上一版不一样，就另记一版，
 * 上一版原样留着——「上回报这个客户多少」「这单前后改过几次价」都靠它答。
 */
import type { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import { 同一份报价, 产品键, 报价合计, type 报价行 } from "./quote";
import { 规整币种 } from "./currency";

type Tx = Prisma.TransactionClient | typeof prisma;

export type 一次报价 = { id: string; quotedAt: string; currency: string; 行: 报价行[]; 合计: number };

const 行查询 = { lines: { orderBy: { sort: "asc" as const }, select: { product: true, spec: true, qty: true, unit: true, unitPrice: true } } };

function 成形(q: { id: string; quotedAt: Date; currency: string; lines: 报价行[] }): 一次报价 {
  return { id: q.id, quotedAt: q.quotedAt.toISOString(), currency: 规整币种(q.currency), 行: q.lines, 合计: 报价合计(q.lines) };
}

/** 这个商机的历次报价，新的在前。第一个就是当前报价 */
export async function 历次报价(opportunityId: string, db: Tx = prisma): Promise<一次报价[]> {
  const qs = await db.quote.findMany({ where: { opportunityId }, orderBy: [{ quotedAt: "desc" }, { id: "desc" }], include: 行查询 });
  return qs.map(成形);
}

/**
 * 保存商机时写报价。和当前那一版一样就什么都不做，返回 null；不一样另记一版。
 * 原来没有报价、这次也是空的，同样不记——「从来没报过价」不需要一行空报价来表示。
 * 原来有、这次清空了，记一版空的：当前报价就是「没有明细」，以前那几版照样在历次里。
 */
export async function 写报价(tx: Tx, opportunityId: string, currency: string, 行: 报价行[]): Promise<一次报价 | null> {
  const 币 = 规整币种(currency);
  const 当前 = await tx.quote.findFirst({ where: { opportunityId }, orderBy: [{ quotedAt: "desc" }, { id: "desc" }], include: 行查询 });
  if (!当前 && 行.length === 0) return null;
  if (当前 && 同一份报价({ currency: 规整币种(当前.currency), 行: 当前.lines }, { currency: 币, 行 })) return null;
  const q = await tx.quote.create({
    data: { opportunityId, currency: 币, lines: { create: 行.map((r, i) => ({ ...r, sort: i })) } },
    include: 行查询,
  });
  return 成形(q);
}

/**
 * 上次报这个客户这个产品是多少（录报价时单价框下面那句提示）。按产品名认（不分大小写、去多余空格），
 * 跨这个客户的所有商机找最近的一次。`除了` 是正在编辑的那个商机——它自己的当前报价就摆在眼前，不用再提示一遍。
 */
export async function 上次报价(customerId: string, product: string, 除了?: string): Promise<{ unitPrice: number; unit: string | null; currency: string; quotedAt: string; 商机: string } | null> {
  const 键 = 产品键(product);
  if (!键) return null;
  const 行们 = await prisma.quoteLine.findMany({
    where: { quote: { opportunity: { customerId, ...(除了 ? { id: { not: 除了 } } : {}) } } },
    orderBy: [{ quote: { quotedAt: "desc" } }, { sort: "asc" }],
    take: 500,
    select: { product: true, unit: true, unitPrice: true, quote: { select: { quotedAt: true, currency: true, opportunity: { select: { name: true } } } } },
  });
  const 中 = 行们.find((r) => 产品键(r.product) === 键);
  if (!中) return null;
  return { unitPrice: 中.unitPrice, unit: 中.unit, currency: 规整币种(中.quote.currency), quotedAt: 中.quote.quotedAt.toISOString(), 商机: 中.quote.opportunity.name };
}

export type 报价记录行 = 报价行 & { quotedAt: string; currency: string; 商机id: string; 商机: string; 状态: string };

/** 客户页「报价记录」：这个客户历次报过的每一行，新的在前（同一次报价里按原顺序） */
export async function 客户报价记录(customerId: string, take = 100): Promise<报价记录行[]> {
  const qs = await prisma.quote.findMany({
    where: { opportunity: { customerId } },
    orderBy: [{ quotedAt: "desc" }, { id: "desc" }],
    take,
    include: { ...行查询, opportunity: { select: { id: true, name: true, status: true } } },
  });
  return qs.flatMap((q) =>
    q.lines.map((r) => ({ ...r, quotedAt: q.quotedAt.toISOString(), currency: 规整币种(q.currency), 商机id: q.opportunity.id, 商机: q.opportunity.name, 状态: q.opportunity.status })),
  );
}
