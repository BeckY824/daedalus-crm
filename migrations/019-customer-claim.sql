-- 公海领取时间（2026-10-04，0.46.15 第 6 块复查）。说明见 prisma/schema.prisma 的 CustomerClaim。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
CREATE TABLE IF NOT EXISTS "CustomerClaim" (
    "customerId" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerClaim_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE
);
