-- 商机的币种（2026-10-03，全站币种）。说明见 prisma/schema.prisma 的 OpportunityMoney。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。Opportunity 只由 schema 建，迁移不能给它加列（空库上从头跑会报表不存在）。
-- 老商机没有这一行，一律当人民币。
CREATE TABLE IF NOT EXISTS "OpportunityMoney" (
    "opportunityId" TEXT NOT NULL PRIMARY KEY,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    CONSTRAINT "OpportunityMoney_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE CASCADE
);
