-- 商机赢单 / 丢单的那一刻（2026-10-02 排查 C6）。说明见 prisma/schema.prisma 的 OpportunityClose。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
CREATE TABLE IF NOT EXISTS "OpportunityClose" (
    "opportunityId" TEXT NOT NULL PRIMARY KEY,
    "closedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OpportunityClose_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE CASCADE
);
