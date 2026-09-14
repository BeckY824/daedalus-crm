-- 托管版：按账号算的赠送账本（桌面端本地模式用）与桌面端长期令牌。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
CREATE TABLE IF NOT EXISTS "AccountAiGrant" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "amount"    INTEGER NOT NULL,
  "reason"    TEXT NOT NULL,
  "key"       TEXT NOT NULL,
  "note"      TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "AccountAiGrant_key_key" ON "AccountAiGrant"("key");
CREATE INDEX IF NOT EXISTS "AccountAiGrant_accountId_idx" ON "AccountAiGrant"("accountId");

CREATE TABLE IF NOT EXISTS "AccountAiUsage" (
  "accountId" TEXT NOT NULL PRIMARY KEY,
  "calls"     INTEGER NOT NULL DEFAULT 0,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "DeviceToken" (
  "id"         TEXT NOT NULL PRIMARY KEY,
  "accountId"  TEXT NOT NULL,
  "tokenHash"  TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" DATETIME,
  "revokedAt"  DATETIME
);
CREATE UNIQUE INDEX IF NOT EXISTS "DeviceToken_tokenHash_key" ON "DeviceToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "DeviceToken_accountId_idx" ON "DeviceToken"("accountId");
