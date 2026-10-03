-- 公海（2026-10-03，0.46.15 第 6 块）。说明见 prisma/schema.prisma 的 CustomerPool。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
-- 用旁表不给 Customer 加列：有这一行 = 在公海，原负责人留在 salesOwnerId 上（显示「公海（原 X）」）。
CREATE TABLE IF NOT EXISTS "CustomerPool" (
    "customerId" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "reason" TEXT NOT NULL DEFAULT '手动',
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerPool_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE
);
