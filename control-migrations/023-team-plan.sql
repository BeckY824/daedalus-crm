-- 团队版按时长开通（2026-10-15，~/Opensource_CRM/02-开发与发版/团队版收费-方案-20261015.md）：
-- 运营台「团队同步」开通 / 续费时选时长和人数，团队有到期日（到点暂停同步、续费自动恢复）和席位数；每次操作留一条记录；
-- 价格表也存这里，运营台改了桌面端「设置 → 团队」马上看到。
-- 单独几张表而不是给 SyncTeam 加列：规矩同前，只加表、IF NOT EXISTS、每次启动整个重跑。
-- 没有行 = 不限期（10-15 之前开通的老团队就是这样，升级后照常同步，运营台提示「未设到期」）。
CREATE TABLE IF NOT EXISTS "SyncTeamPlan" (
    "teamId" TEXT NOT NULL PRIMARY KEY,
    "paidUntil" DATETIME,
    "seats" INTEGER,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "SyncTeamPlanLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "months" INTEGER,
    "days" INTEGER,
    "seats" INTEGER,
    "amount" REAL,
    "before" DATETIME,
    "after" DATETIME,
    "note" TEXT
);
CREATE INDEX IF NOT EXISTS "SyncTeamPlanLog_teamId_at_idx" ON "SyncTeamPlanLog"("teamId", "at");
CREATE TABLE IF NOT EXISTS "SyncPricing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "prices" TEXT NOT NULL,
    "trialDays" INTEGER NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by" TEXT
);
