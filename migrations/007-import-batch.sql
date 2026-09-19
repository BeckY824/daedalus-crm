-- 导入批次：一次导入一个批次号，整批可回滚。
--
-- 为什么要有这两张表，而不是把批次号塞进 AuditLog 的 detail JSON 里：
-- 撤销要按批次把这一批写进去的记录一条条找回来，而在 JSON 里 LIKE 是没有索引的全表扫，
-- 并且「这一批建了哪几条」是一个业务事实，不是一条日志的附注。
--
-- 撤销这件事本身是产品承诺的一部分：Attio 没有撤销，导错了只能手动删。
-- 我们的用户是一个人，导错了没有管理员救他，也没有客服帮他跑脚本。
--
-- 列一次留全（这个目录只能加表不能加列）：sheetName 眼下不填，
-- 多工作表要支持时才用得上。
--
-- 不与 User 建外键：成员被删不该带走导入历史，也不该让删人这件事卡在这儿。

CREATE TABLE IF NOT EXISTS "ImportBatch" (
    "id"         TEXT NOT NULL PRIMARY KEY,
    "at"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId"     TEXT NOT NULL,
    "userName"   TEXT NOT NULL,
    -- 导的是哪个文件，给人认批次用。只存文件名，不存内容
    "fileName"   TEXT NOT NULL,
    "sheetName"  TEXT,
    "created"    INTEGER NOT NULL DEFAULT 0,
    "updated"    INTEGER NOT NULL DEFAULT 0,
    "skipped"    INTEGER NOT NULL DEFAULT 0,
    "failed"     INTEGER NOT NULL DEFAULT 0,
    -- 撤销过就有值；撤销过的批次不能再撤一次
    "revertedAt" DATETIME
);
CREATE INDEX IF NOT EXISTS "ImportBatch_at_idx" ON "ImportBatch"("at");

CREATE TABLE IF NOT EXISTS "ImportRow" (
    "id"         TEXT NOT NULL PRIMARY KEY,
    "batchId"    TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    -- create = 这条是这次导入建的（撤销时删掉）
    -- update = 这次只补了它的空字段（撤销时把那几格还原）
    "kind"       TEXT NOT NULL,
    -- update 时这几格原来是什么（JSON）。按定义全是空值，存下来是为了让撤销
    -- 照着数据走而不是照着「我记得只补空的」这条约定走
    "before"     TEXT,
    CONSTRAINT "ImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch" ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "ImportRow_batchId_idx" ON "ImportRow"("batchId");
CREATE INDEX IF NOT EXISTS "ImportRow_customerId_idx" ON "ImportRow"("customerId");
