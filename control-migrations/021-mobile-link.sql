-- 手机连团队（2026-10-15，手机端方案 3.2）：手机用账号密码登录后发申请，本人的电脑点「允许」才把团队钥匙封给它。
-- 这里只存手机的公钥、状态、电脑封好的密文（我们解不开）。规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
CREATE TABLE IF NOT EXISTS "SyncMobileLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "pubKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "teamId" TEXT,
    "sealed" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" DATETIME,
    "proofHash" TEXT,
    "proofDevice" TEXT,
    "proofAt" DATETIME
);
CREATE UNIQUE INDEX IF NOT EXISTS "SyncMobileLink_tokenId_key" ON "SyncMobileLink"("tokenId");
CREATE INDEX IF NOT EXISTS "SyncMobileLink_accountId_status_idx" ON "SyncMobileLink"("accountId", "status");
