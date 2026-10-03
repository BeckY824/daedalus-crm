/**
 * 商机 / 签约的币种和金额，读写都走这里（2026-10-03 全站币种）。
 *
 * 币种不在 Opportunity / Contract 表上，在旁边的 OpportunityMoney / ContractMoney（为什么见 prisma/schema.prisma）。
 * 查询时 `include: 带币种.商机` / `带币种.签约`，拿到行以后用 商机币种() / 签约币种() / 签约金额() 取值——
 * 不要在调用处自己写 `o.money?.currency ?? "CNY"`：规整（大小写、认不得的币种）只有一份。
 */
import type { Prisma } from "@/generated/prisma";
import { 规整币种, 默认币种, 按币种合计 } from "./currency";

export const 带币种 = {
  商机: { money: { select: { currency: true } } },
  签约: { money: { select: { currency: true, amountExact: true } } },
} as const;

type 有币种 = { money?: { currency: string | null } | null };
type 签约行 = { amount: number; money?: { currency: string | null; amountExact?: number | null } | null };

export function 商机币种(o: 有币种): string {
  return 规整币种(o.money?.currency, 默认币种);
}
export function 签约币种(c: 有币种): string {
  return 规整币种(c.money?.currency, 默认币种);
}
/** 签约金额：有精确值（带小数的外币）用它，没有退回 Contract.amount（整数、元） */
export function 签约金额(c: 签约行): number {
  const x = c.money?.amountExact;
  return typeof x === "number" && Number.isFinite(x) ? x : c.amount;
}

/** 一批签约按币种合计（不换汇）：[{ 币种: "USD", 合计: 3200 }, …] */
export function 签约合计(list: 签约行[]): { 币种: string; 合计: number }[] {
  return 按币种合计(list, 签约金额, (c) => 签约币种(c));
}

type Tx = Prisma.TransactionClient | { opportunityMoney: Prisma.TransactionClient["opportunityMoney"]; contractMoney: Prisma.TransactionClient["contractMoney"] };

/** 写商机币种。人民币也写一行——「没有这一行」只留给 0.46.15 之前的老数据 */
export async function 写商机币种(tx: Tx, opportunityId: string, 币种: unknown): Promise<void> {
  const currency = 规整币种(币种);
  await tx.opportunityMoney.upsert({ where: { opportunityId }, create: { opportunityId, currency }, update: { currency } });
}

/**
 * 写签约币种和精确金额。Contract.amount 照旧写四舍五入的整数——老报表、老客户端、导出都还认它；
 * 精确值放 amountExact，读的时候以它为准。
 */
export async function 写签约金额(tx: Tx, contractId: string, 币种: unknown, 精确: number): Promise<void> {
  const currency = 规整币种(币种);
  await tx.contractMoney.upsert({
    where: { contractId },
    create: { contractId, currency, amountExact: 精确 },
    update: { currency, amountExact: 精确 },
  });
}
