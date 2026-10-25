import type { Prisma, PrismaClient } from "@/generated/prisma";
import { 按币种合计, 规整币种, 默认币种, type 币种合计 } from "@/lib/currency";
import { 带币种, 商机币种 } from "@/lib/money-db";

/**
 * 商机列表顶上的汇总药丸：单数、按币种的金额合计、按币种的预测（金额 × 赢单率）。
 *
 * 口径（排查 C7 / 审查 M12）：按全量算，不是取回来的前 300 行；没筛状态时只算进行中的。
 * 原来是把这些商机整份取回来（带币种那个一对一关联）在 JS 里加：企业版 1 万进行中的商机，
 * 每打开一次商机页约 30 毫秒，几乎全是 Prisma 拼对象的 CPU，30 人同时用时排队拖长 p95（2026-10-25 压测）。
 * 不限定时改成库里按币种 GROUP BY，约 2 毫秒：
 *
 * - 币种照旧由 规整币种 认（大小写、认不得的、没有币种那一行的都归到默认币种），所以库里只按原样分组，
 *   回来再规整、同一币种的几组合起来
 * - 金额相同的币种谁排前面：原来按「第一次出现」（不排序的整表扫，按 rowid），这里按每组最小的 rowid 排，一样
 * - 每行的预测值 amount * (probability / 100.0) 和 JS 的算法一样；只有加的先后不同，差在最后一两位小数，显示不出来
 *
 * 只在**不限定**（老板、个人版、企业版没开按组织看）且只按状态 / 阶段 / 负责人筛时走库里：
 * 裸 SQL 不过 lib/team-scope 的那层 where，业务员照旧在限定后的行上加；按关键词搜要连客户表，也照旧。
 * tests/opportunity-summary.test.ts 拿原来的算法对拍。
 */

export type 商机汇总 = { 单数: number; 合计: 币种合计[]; 预测: 币种合计[] };

export type 汇总筛选 = { 关键词?: string; stage?: string; status?: string; ownerId?: string };

/** 原来那条路：取行在 JS 里加。where 是列表页拼好的那份 */
export async function 取行汇总(db: PrismaClient, where: Prisma.OpportunityWhereInput, 筛状态: boolean): Promise<商机汇总> {
  const 行 = await db.opportunity.findMany({
    where: { ...where, ...(筛状态 ? {} : { status: "OPEN" }) },
    select: { amount: true, probability: true, status: true, ...带币种.商机 },
  });
  return {
    单数: 行.length,
    // 按币种分开（不换汇）：美元单和人民币单加在一起是假数字
    合计: 按币种合计(行, (o) => o.amount, 商机币种),
    预测: 按币种合计(行.filter((o) => o.status === "OPEN"), (o) => o.amount * (o.probability / 100), 商机币种),
  };
}

/** 库里按币种分组加 */
async function 库里汇总(db: PrismaClient, 筛: 汇总筛选): Promise<商机汇总> {
  const 状态 = 筛.status || "OPEN";
  const 条件 = ["o.status = ?"];
  const 参数: string[] = [状态];
  if (筛.stage) { 条件.push("o.stage = ?"); 参数.push(筛.stage); }
  if (筛.ownerId) { 条件.push("o.ownerId = ?"); 参数.push(筛.ownerId); }
  const 组 = await db.$queryRawUnsafe<{ currency: string | null; n: bigint | number; s: number | null; p: number | null; r: bigint | number }[]>(
    `SELECT m.currency AS currency, COUNT(*) AS n, SUM(o.amount) AS s, SUM(o.amount * (o.probability / 100.0)) AS p, MIN(o.rowid) AS r
     FROM Opportunity o LEFT JOIN OpportunityMoney m ON m.opportunityId = o.id
     WHERE ${条件.join(" AND ")}
     GROUP BY m.currency`,
    ...参数,
  );
  // 规整以后同一币种的几组合起来；先后按第一次出现
  const 合: Map<string, { r: number; s: number; p: number }> = new Map();
  let 单数 = 0;
  for (const g of [...组].sort((a, b) => Number(a.r) - Number(b.r))) {
    const 码 = 规整币种(g.currency, 默认币种);
    const x = 合.get(码) ?? { r: Number(g.r), s: 0, p: 0 };
    x.s += Number(g.s) || 0;
    x.p += Number(g.p) || 0;
    合.set(码, x);
    单数 += Number(g.n);
  }
  const 排 = (取: (x: { s: number; p: number }) => number) =>
    [...合.entries()].map(([币种, x]) => ({ 币种, 合计: 取(x) })).sort((a, b) => b.合计 - a.合计);
  return {
    单数,
    合计: 排((x) => x.s),
    // 原来是在取回来的行里挑进行中的：筛了别的状态就一行都没有
    预测: 状态 === "OPEN" ? 排((x) => x.p) : [],
  };
}

/**
 * 列表页用的入口。`不限定` 由调用方按 lib/team-scope 判（限定的我 为 null）。
 * where 是页面拼好的那份（取行那条路用），筛 是拼它的那几个参数（库里那条路用），两份必须是同一组筛选
 */
export async function 商机汇总(db: PrismaClient, where: Prisma.OpportunityWhereInput, 筛: 汇总筛选, 不限定: boolean): Promise<商机汇总> {
  // 地址栏里同一个参数写两遍会变成数组：那种照旧交给 Prisma（它会报错，和原来一样）
  const 都是串 = [筛.stage, 筛.status, 筛.ownerId].every((v) => v === undefined || typeof v === "string");
  if (!不限定 || 筛.关键词 || !都是串) return 取行汇总(db, where, Boolean(筛.status));
  return 库里汇总(db, 筛);
}
