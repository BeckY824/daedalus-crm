CREATE TABLE IF NOT EXISTS "SyncPrivacy" (
 "teamId" TEXT NOT NULL PRIMARY KEY, "stage" TEXT NOT NULL, "device" TEXT NOT NULL,
 "fence" INTEGER NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "SyncScopedRecord" (
 "teamId" TEXT NOT NULL, "key" TEXT NOT NULL, "metadata" TEXT NOT NULL,
 PRIMARY KEY ("teamId", "key")
);
CREATE TABLE IF NOT EXISTS "SyncScopedBatch" (
 "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "teamId" TEXT NOT NULL,
 "device" TEXT NOT NULL, "accountId" TEXT NOT NULL, "recordKey" TEXT NOT NULL,
 "eventId" TEXT NOT NULL, "metadata" TEXT NOT NULL, "digest" TEXT NOT NULL,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "SyncScopedBatch_teamId_device_eventId_key" ON "SyncScopedBatch"("teamId", "device", "eventId");
CREATE INDEX IF NOT EXISTS "SyncScopedBatch_teamId_recordKey_id_idx" ON "SyncScopedBatch"("teamId", "recordKey", "id");
