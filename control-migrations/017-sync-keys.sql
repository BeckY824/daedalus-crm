-- 团队同步：设备公钥、换钥匙（2026-10-04，0.46.15）。说明见 prisma/control.prisma 的 SyncDevice / SyncKey。只加表。
CREATE TABLE IF NOT EXISTS "SyncDevice" (
    "teamId" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "pubKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("teamId", "device")
);
CREATE INDEX IF NOT EXISTS "SyncDevice_teamId_accountId_idx" ON "SyncDevice"("teamId", "accountId");
CREATE TABLE IF NOT EXISTS "SyncKey" (
    "teamId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "ring" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("teamId", "epoch")
);
CREATE TABLE IF NOT EXISTS "SyncKeyEnvelope" (
    "teamId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "device" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    PRIMARY KEY ("teamId", "epoch", "device")
);
