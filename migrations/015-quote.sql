-- 报价明细（2026-10-03，0.46.15 外贸第 3 块）。说明见 prisma/schema.prisma 的 Quote / QuoteLine。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
-- 一次报价 = 一行 Quote + 若干 QuoteLine。改价不覆盖旧的，另记一版：「历次报价」就是同一个商机的几行 Quote。
CREATE TABLE IF NOT EXISTS "Quote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "opportunityId" TEXT NOT NULL,
    "quotedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    CONSTRAINT "Quote_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "Quote_opportunityId_idx" ON "Quote"("opportunityId");
CREATE TABLE IF NOT EXISTS "QuoteLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "quoteId" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "product" TEXT NOT NULL,
    "spec" TEXT,
    "qty" REAL NOT NULL DEFAULT 0,
    "unit" TEXT,
    "unitPrice" REAL NOT NULL DEFAULT 0,
    CONSTRAINT "QuoteLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote" ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "QuoteLine_quoteId_idx" ON "QuoteLine"("quoteId");
