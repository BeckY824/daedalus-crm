-- 托管版：AI 免费次数的赠送账本（注册送、每日送、邀请码送、运营台加）。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
CREATE TABLE IF NOT EXISTS "AiGrant" (
  "id"          TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "amount"      INTEGER NOT NULL,
  "reason"      TEXT NOT NULL,
  "key"         TEXT NOT NULL,
  "note"        TEXT,
  "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "AiGrant_key_key" ON "AiGrant"("key");
CREATE INDEX IF NOT EXISTS "AiGrant_workspaceId_idx" ON "AiGrant"("workspaceId");
