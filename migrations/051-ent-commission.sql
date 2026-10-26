-- 企业版提成（2026-10-26）：每个项目一份提成表（项目底价 + 赢单时固定下来的实际提成）、组长分给组员的比例。
-- 说明见 prisma/schema.prisma 的 EntCommission / EntCommissionSplit。底价提成、溢价提成的两个比例存 Setting（entCommissionRates），默认值在代码里。
-- 只在企业版（CRM_ENTERPRISE=1）写；桌面端、团队版也建这两张空表，不读。
-- 规矩同 045：只加表、IF NOT EXISTS、每次启动整个重跑；指向人的列不建外键，项目删了随项目级联（同 042 的 ProjectMember）。
CREATE TABLE IF NOT EXISTS "EntCommission" (
    "projectId" TEXT NOT NULL PRIMARY KEY,
    "basePrice" REAL,
    "updatedById" TEXT,
    "fixedAt" DATETIME,
    "fixedDeal" REAL,
    "fixedBase" REAL,
    "fixedRateBase" REAL,
    "fixedRatePremium" REAL,
    "fixedTotal" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EntCommission_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "EntCommissionSplit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "percent" REAL NOT NULL,
    "setById" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EntCommissionSplit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "EntCommissionSplit_projectId_userId_key" ON "EntCommissionSplit"("projectId", "userId");
