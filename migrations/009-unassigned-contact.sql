-- 未归属联系人（2026-10-01，用户反馈：在客户详情里删联系人，联系人页里也跟着没了）。说明见 prisma/schema.prisma。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
CREATE TABLE IF NOT EXISTS "UnassignedContact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "position" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "wechat" TEXT,
    "remark" TEXT,
    "fromCustomerId" TEXT,
    "fromCustomerName" TEXT,
    "followUpIds" TEXT,
    "detachedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
