import { prisma, defaultClient } from "@/lib/prisma";
import { 读的我 } from "@/lib/team-scope";

/**
 * 业务员（企业版按组织看、团队版没开互看）看得到的客户，用裸 SQL 数和挑，不走 Prisma 那层 where。
 *
 * lib/team-scope 的 可见客户 = 负责人是我 OR 渠道负责人是我 OR 在公海。Prisma 把「在公海」展开成
 * Customer LEFT JOIN CustomerPool，OR 起来 SQLite 用不上负责人的索引，只能整张客户表扫一遍：
 * 10 万客户一次计数 ~20 ms，30 人同时开页面时排在只读连接上要等上百毫秒（2026-10-26 企业版 p95）。
 * 这里把「在公海」写成 id IN (SELECT customerId FROM CustomerPool)（customerId 是外键、删客户连带删），
 * 三个条件都能走索引，SQLite 用 MULTI-INDEX OR 各取一段再合起来，只碰看得到的那几千行。
 * 试过三段 UNION：计数也快，但挑前 n 位时要把几万个编号先攒出来再排，经理（看四五万位）反而比原来慢一倍。
 *
 * 范围用 读的我()：和钩子给 Customer 读加的那一句同一个名单（企业版虚线下属算「读」）；null = 不限定，
 * 调用方照旧走 Prisma（不限定时 Prisma 那句本来就快）。tests/scope-sql.test.ts 逐个身份拿 Prisma 对拍
 */
async function 看得到的(): Promise<{ where: string; 参数: string[] } | null> {
  const 我 = await 读的我(defaultClient);
  if (!我) return null;
  const 们 = typeof 我 === "string" ? [我] : [...我];
  if (!们.length) 们.push("__无");
  const 占 = 们.map(() => "?").join(",");
  return {
    where: `c."salesOwnerId" IN (${占}) OR c."channelOwnerId" IN (${占}) OR c.id IN (SELECT "customerId" FROM "CustomerPool")`,
    参数: [...们, ...们],
  };
}

/** 看得到的客户一共几位（= prisma.customer.count()） */
export async function 看得到的客户数(): Promise<number> {
  const 范围 = await 看得到的();
  if (!范围) return prisma.customer.count();
  const [r] = await prisma.$queryRawUnsafe<{ n: bigint | number }[]>(`SELECT COUNT(*) AS n FROM "Customer" c WHERE ${范围.where}`, ...范围.参数);
  return Number(r.n);
}

/**
 * 看得到的客户里最近跟进的前 n 位的编号，顺序同 orderBy [lastFollowAt desc, createdAt desc]（同一列、同一个 ORDER BY，
 * 没跟进过的照 SQLite 排在最后）。null = 不限定，调用方照旧用 Prisma 排
 */
export async function 最近跟进的客户(n: number): Promise<string[] | null> {
  const 范围 = await 看得到的();
  if (!范围) return null;
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT c.id FROM "Customer" c WHERE ${范围.where} ORDER BY c."lastFollowAt" DESC, c."createdAt" DESC LIMIT ?`,
    ...范围.参数,
    n,
  );
  return rows.map((r) => r.id);
}
