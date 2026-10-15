-- 团队版多设备同步（2026-10-15，~/Opensource_CRM/02-开发与发版/多设备同步-方案-20261015.md）：
-- 同一个人的每台设备最近同步时间和登录令牌（我的设备、移除时作废令牌）；移除设备后待老板换钥匙的团队。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
CREATE TABLE IF NOT EXISTS "SyncDeviceSeen" (
    "teamId" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tokenId" TEXT,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("teamId", "device")
);
CREATE TABLE IF NOT EXISTS "SyncRekeyWanted" (
    "teamId" TEXT NOT NULL PRIMARY KEY,
    "wantedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
