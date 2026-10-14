-- 范围同步：记录进入新范围后，新获权者只拿「当前状态起点」，不拿失权期间的历史密文（2026-10-13）。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
CREATE TABLE IF NOT EXISTS "SyncScopedBaseline" (
 "teamId" TEXT NOT NULL, "recordKey" TEXT NOT NULL, "batchId" INTEGER NOT NULL,
 PRIMARY KEY ("teamId", "batchId")
);
CREATE INDEX IF NOT EXISTS "SyncScopedBaseline_teamId_recordKey_batchId_idx" ON "SyncScopedBaseline"("teamId", "recordKey", "batchId");
