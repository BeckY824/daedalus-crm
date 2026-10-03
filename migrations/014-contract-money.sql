-- 签约的币种和精确金额（2026-10-03，全站币种）。说明见 prisma/schema.prisma 的 ContractMoney。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。Contract.amount 是 Int（元），美元带美分存不下，精确值放 amountExact。
-- 老签约没有这一行：人民币、按 Contract.amount。
CREATE TABLE IF NOT EXISTS "ContractMoney" (
    "contractId" TEXT NOT NULL PRIMARY KEY,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "amountExact" REAL,
    CONSTRAINT "ContractMoney_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract" ("id") ON DELETE CASCADE
);
