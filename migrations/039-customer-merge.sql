-- 合并重复客户（2026-10-20，团队版疑似重复批量合并）。说明见 prisma/schema.prisma 的 CustomerMerge、CustomerNotDupe。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。两张都不建外键（被合并的那位合并完就删了，记号要留着）。
CREATE TABLE IF NOT EXISTS "CustomerMerge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fromId" TEXT NOT NULL,
    "intoId" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "fromOwnerName" TEXT,
    "userId" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "CustomerMerge_intoId_idx" ON "CustomerMerge"("intoId");
CREATE TABLE IF NOT EXISTS "CustomerNotDupe" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "otherId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "CustomerNotDupe_customerId_idx" ON "CustomerNotDupe"("customerId");
CREATE INDEX IF NOT EXISTS "CustomerNotDupe_otherId_idx" ON "CustomerNotDupe"("otherId");
