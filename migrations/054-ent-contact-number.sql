-- 企业版客户的其他号码（2026-10-26，测试清单 B5：旺旺 ID）。说明见 prisma/schema.prisma 的 EntContactNumber。
-- 邮箱、微信沿用 CustomerExtra 已有的两列，这里只放现有列里没有的类型（现在只有旺旺 ID）。
-- 只建表和索引，老数据不动。
CREATE TABLE IF NOT EXISTS "EntContactNumber" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "numberKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EntContactNumber_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "EntContactNumber_customerId_idx" ON "EntContactNumber"("customerId");
CREATE INDEX IF NOT EXISTS "EntContactNumber_kind_numberKey_idx" ON "EntContactNumber"("kind", "numberKey");
