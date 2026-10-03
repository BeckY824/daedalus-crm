-- 团队同步（2026-10-03，0.46.15 第 5 块）。说明见 prisma/control.prisma 的 SyncTeam。只加表。
CREATE TABLE IF NOT EXISTS "SyncTeam" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "ownerAccountId" TEXT NOT NULL,
    "joinSecretHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "activatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "SyncTeam_ownerAccountId_idx" ON "SyncTeam"("ownerAccountId");
CREATE TABLE IF NOT EXISTS "SyncMember" (
    "teamId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" DATETIME,
    PRIMARY KEY ("teamId", "accountId")
);
CREATE INDEX IF NOT EXISTS "SyncMember_accountId_idx" ON "SyncMember"("accountId");
CREATE TABLE IF NOT EXISTS "SyncBatch" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "teamId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "SyncBatch_teamId_id_idx" ON "SyncBatch"("teamId", "id");
