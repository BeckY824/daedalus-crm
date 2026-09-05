-- 操作留痕表。存量库靠这个文件补建，全新安装走构建期生成的 schema.sql，
-- 两条路径都会得到同一张表（这里全部用 IF NOT EXISTS，重复执行无副作用）。
--
-- 这张表刻意不与 User 建外键：日志只增不改不删，
-- 不该因为某个成员被删掉就丢失或被置空。也因此它永远不需要 ALTER。

CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "summary" TEXT NOT NULL,
    "detail" TEXT
);

CREATE INDEX IF NOT EXISTS "AuditLog_at_idx" ON "AuditLog"("at");
CREATE INDEX IF NOT EXISTS "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");
CREATE INDEX IF NOT EXISTS "AuditLog_userId_idx" ON "AuditLog"("userId");
