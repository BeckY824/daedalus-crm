-- 托管版：试用激活码。一码一个工作区，替代注册时的短信/邮件验证码。
-- 规矩同 001：只加表、CREATE IF NOT EXISTS、每次启动整个重跑。
CREATE TABLE IF NOT EXISTS "ActivationCode" (
  "code"        TEXT NOT NULL PRIMARY KEY,
  "note"        TEXT,
  "usedAt"      DATETIME,
  "usedBy"      TEXT,
  "workspaceId" TEXT,
  "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ActivationCode_usedAt_idx" ON "ActivationCode"("usedAt");
