-- 签约那一刻是谁的单（2026-10-02 排查 B2）。说明见 prisma/schema.prisma 的 ContractOwner。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。老签约没有这一行，报表退回按客户现在的负责人算。
CREATE TABLE IF NOT EXISTS "ContractOwner" (
    "contractId" TEXT NOT NULL PRIMARY KEY,
    "salesOwnerId" TEXT,
    "channelOwnerId" TEXT,
    CONSTRAINT "ContractOwner_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract" ("id") ON DELETE CASCADE
);
