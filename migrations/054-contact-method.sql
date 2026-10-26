-- 企业版联系方式子表（2026-10-26，测试清单 B1 / B5 / B8、融合对照 §2 / §8.1 B1）。说明见 prisma/schema.prisma 的 ContactMethod。
-- 一行一个号：类型 + 原样 + 规整值 + 格式结果 + 归属地。全公司查重按 kind + numberKey 比。
-- 只建表和索引，老数据不动（老号码还在 Customer.phone / Contact / CustomerExtra，查重两边都比；回填见 PR 说明）。
CREATE TABLE IF NOT EXISTS "ContactMethod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "contactId" TEXT,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "numberKey" TEXT NOT NULL,
    "formatStatus" TEXT NOT NULL DEFAULT 'ok',
    "region" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContactMethod_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ContactMethod_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ContactMethod_customerId_idx" ON "ContactMethod"("customerId");
CREATE INDEX IF NOT EXISTS "ContactMethod_contactId_idx" ON "ContactMethod"("contactId");
CREATE INDEX IF NOT EXISTS "ContactMethod_kind_numberKey_idx" ON "ContactMethod"("kind", "numberKey");
