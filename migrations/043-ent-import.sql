-- 企业版数据接入（2026-10-24）：批次、写过的行、原系统对照、冲突、整批撤回的回收站、切换日快照。说明见 prisma/schema.prisma 的 EntImportBatch。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑；现有表一列不动。六张表都不进团队同步（src/lib/sync/tables.ts 的 不同步表）。
-- 指向人的列不建外键（同 TradeOrder.ownerId），改身份时按 src/lib/sync/tables.ts 的 指向人的列 一起改。
CREATE TABLE IF NOT EXISTS "EntImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'full',
    "status" TEXT NOT NULL DEFAULT 'preview',
    "userId" TEXT,
    "report" TEXT,
    "raw" TEXT,
    "mapping" TEXT,
    "plan" TEXT,
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "conflicts" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "revertedAt" DATETIME,
    "revertNote" TEXT
);

CREATE TABLE IF NOT EXISTS "EntImportRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "before" TEXT,
    "written" TEXT NOT NULL,
    "refBefore" TEXT,
    "undo" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EntImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "EntImportBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "EntExternalRef" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "written" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "batchId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS "EntConflict" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "batchId" TEXT,
    "fields" TEXT NOT NULL,
    "incoming" TEXT NOT NULL,
    "localDeleted" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT '待定',
    "resolvedById" TEXT,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "EntTrash" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "ref" TEXT,
    "rowId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoredAt" DATETIME
);

CREATE TABLE IF NOT EXISTS "EntSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "userId" TEXT,
    "count" INTEGER NOT NULL DEFAULT 0,
    "data" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "EntImportBatch_createdAt_idx" ON "EntImportBatch"("createdAt");

CREATE INDEX IF NOT EXISTS "EntImportRow_batchId_entity_idx" ON "EntImportRow"("batchId", "entity");

CREATE INDEX IF NOT EXISTS "EntExternalRef_entity_targetId_idx" ON "EntExternalRef"("entity", "targetId");

CREATE UNIQUE INDEX IF NOT EXISTS "EntExternalRef_source_entity_externalId_key" ON "EntExternalRef"("source", "entity", "externalId");

CREATE INDEX IF NOT EXISTS "EntConflict_status_createdAt_idx" ON "EntConflict"("status", "createdAt");

CREATE INDEX IF NOT EXISTS "EntConflict_source_entity_externalId_idx" ON "EntConflict"("source", "entity", "externalId");

CREATE INDEX IF NOT EXISTS "EntTrash_batchId_idx" ON "EntTrash"("batchId");

