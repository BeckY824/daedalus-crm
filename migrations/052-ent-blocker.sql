-- 企业版卡点（2026-10-26）：卡点、卡点流转、沟通记录编号 / 下次时间。说明见 prisma/schema.prisma 的 EntBlocker / EntBlockerLog / EntFollowUpMeta。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑；现有表一列不动。卡点默认值存 Setting，由代码第一次读时兜底（这里不许 INSERT）。
-- 指向人的列不建外键（同 Project.ownerId），改身份时按 src/lib/sync/tables.ts 的 指向人的列 一起改。
CREATE TABLE IF NOT EXISTS "EntBlocker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "followUpId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "contactId" TEXT,
    "phase" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "obstacle" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "dueDays" INTEGER NOT NULL,
    "dueAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT '看板',
    "assigneeId" TEXT,
    "creatorId" TEXT NOT NULL,
    "resourceRequest" TEXT,
    "progress" TEXT,
    "solution" TEXT,
    "result" TEXT,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EntBlocker_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EntBlocker_followUpId_fkey" FOREIGN KEY ("followUpId") REFERENCES "FollowUp" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "EntBlocker_code_key" ON "EntBlocker"("code");
CREATE INDEX IF NOT EXISTS "EntBlocker_projectId_status_idx" ON "EntBlocker"("projectId", "status");
CREATE INDEX IF NOT EXISTS "EntBlocker_assigneeId_status_idx" ON "EntBlocker"("assigneeId", "status");
CREATE TABLE IF NOT EXISTS "EntBlockerLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "blockerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "fromUserId" TEXT,
    "toUserId" TEXT,
    "note" TEXT,
    CONSTRAINT "EntBlockerLog_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "EntBlocker" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "EntBlockerLog_blockerId_at_idx" ON "EntBlockerLog"("blockerId", "at");
CREATE TABLE IF NOT EXISTS "EntFollowUpMeta" (
    "followUpId" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nextAt" DATETIME,
    CONSTRAINT "EntFollowUpMeta_followUpId_fkey" FOREIGN KEY ("followUpId") REFERENCES "FollowUp" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EntFollowUpMeta_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "EntFollowUpMeta_code_key" ON "EntFollowUpMeta"("code");
CREATE INDEX IF NOT EXISTS "EntFollowUpMeta_projectId_idx" ON "EntFollowUpMeta"("projectId");
