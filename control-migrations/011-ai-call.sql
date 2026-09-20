-- 每一次模型调用花了多少 token。规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
--
-- 为什么是新表而不是给 AiUsage / AccountAiUsage 加两列：
--   1. 那两张是**单行计数器**（一个 owner 一行、只有 calls），存不了曲线
--   2. control-migrations 每次启动整个重跑，而 SQLite 没有 ADD COLUMN IF NOT EXISTS
CREATE TABLE IF NOT EXISTS "AiCall" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "ownerKind"    TEXT NOT NULL,
  "ownerId"      TEXT NOT NULL,
  "model"        TEXT NOT NULL,
  "inputTokens"  INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "feature"      TEXT,
  "at"           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "AiCall_at_idx" ON "AiCall"("at");
CREATE INDEX IF NOT EXISTS "AiCall_owner_idx" ON "AiCall"("ownerKind", "ownerId");
