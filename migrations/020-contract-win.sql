-- 登记签约时顺手标成赢单的商机（2026-10-04 L-007）。说明见 prisma/schema.prisma 的 ContractWin。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
CREATE TABLE IF NOT EXISTS "ContractWin" (
    "opportunityId" TEXT NOT NULL PRIMARY KEY,
    "contractId" TEXT NOT NULL,
    "prevStage" TEXT NOT NULL,
    "prevProbability" INTEGER NOT NULL,
    CONSTRAINT "ContractWin_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE CASCADE,
    CONSTRAINT "ContractWin_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract" ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "ContractWin_contractId_idx" ON "ContractWin"("contractId");
