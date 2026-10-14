import { Prisma } from "@/generated/prisma";

/**
 * 转交不代表业务推进（L-029），但 updatedAt 必须前进，旧编辑框才能被版本闸门拦住。
 * 调用方在自己的授权事务内传入范围；先查到实际匹配的ID，再分批保留旧业务时间。
 * 原生 UPDATE 和 ORM 写都在同一事务，团队同步触发器也会记录 activityAt。
 */
export async function 转交商机(db: Prisma.TransactionClient, where: Prisma.OpportunityWhereInput, ownerId: string) {
  const rows = await db.opportunity.findMany({ where, select: { id: true, updatedAt: true } });
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const ids = batch.map((r) => r.id);
    await db.$executeRaw(Prisma.sql`UPDATE "Opportunity" SET "activityAt" = "updatedAt" WHERE "id" IN (${Prisma.join(ids)}) AND "activityAt" IS NULL`);
    const updatedAt = new Date(Math.max(Date.now(), ...batch.map((r) => r.updatedAt.getTime() + 1)));
    await db.opportunity.updateMany({ where: { id: { in: ids } }, data: { ownerId, updatedAt } });
  }
}
