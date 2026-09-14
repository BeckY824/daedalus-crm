-- 托管版：演示码（一码一人、cookie 绑定、5 次 AI）与万能试用码（一行、可换）。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
CREATE TABLE IF NOT EXISTS "DemoCode" (
  "code"         TEXT NOT NULL PRIMARY KEY,
  "note"         TEXT,
  "boundVisitor" TEXT,
  "boundAt"      DATETIME,
  "calls"        INTEGER NOT NULL DEFAULT 0,
  "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "DemoCode_boundVisitor_key" ON "DemoCode"("boundVisitor");
CREATE TABLE IF NOT EXISTS "TrialMasterCode" (
  "id"        TEXT NOT NULL PRIMARY KEY DEFAULT 'trial',
  "code"      TEXT NOT NULL,
  "rotatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
