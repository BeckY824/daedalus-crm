-- 客户的外贸档案（2026-10-05，0.46.16 外贸客户建议）：国家、WhatsApp、微信、邮箱、来源。说明见 prisma/schema.prisma 的 CustomerExtra。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。Customer 是 schema 建的老表，不能加列（空库从头跑迁移时它还不存在），所以放旁表。
CREATE TABLE IF NOT EXISTS "CustomerExtra" (
    "customerId" TEXT NOT NULL PRIMARY KEY,
    "country" TEXT,
    "whatsapp" TEXT,
    "wechat" TEXT,
    "email" TEXT,
    "source" TEXT,
    CONSTRAINT "CustomerExtra_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "CustomerExtra_country_idx" ON "CustomerExtra"("country");
