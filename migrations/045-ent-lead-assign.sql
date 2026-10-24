-- 企业版线索分配（2026-10-24）：分配记录 + 每人每月配额。说明见 prisma/schema.prisma 的 EntLeadAssign / EntLeadQuota。
-- 只在企业版（CRM_ENTERPRISE=1）且「线索分配」规则开着时写；桌面端、团队版也建这两张空表，不读。
-- 规矩同 044-ent-org：只加表、IF NOT EXISTS、每次启动整个重跑、不建外键。
CREATE TABLE IF NOT EXISTS "EntLeadAssign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leadId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "fromUserId" TEXT,
    "byUserId" TEXT NOT NULL,
    "line" TEXT,
    "kind" TEXT NOT NULL DEFAULT '营销',
    "counted" BOOLEAN NOT NULL DEFAULT true,
    "month" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "EntLeadAssign_toUserId_month_idx" ON "EntLeadAssign"("toUserId", "month");
CREATE INDEX IF NOT EXISTS "EntLeadAssign_fromUserId_idx" ON "EntLeadAssign"("fromUserId");
CREATE INDEX IF NOT EXISTS "EntLeadAssign_leadId_idx" ON "EntLeadAssign"("leadId");
CREATE TABLE IF NOT EXISTS "EntLeadQuota" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "quota" INTEGER NOT NULL,
    "setById" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
