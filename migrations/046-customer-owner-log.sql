-- 客户换负责人的记录（2026-10-24，企业版离职交接 D-36）。说明见 prisma/schema.prisma 的 CustomerOwnerLog。
-- 只建表和索引，老数据不动（老客户没有记录 = 以前没记，不补）。
CREATE TABLE IF NOT EXISTS "CustomerOwnerLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fromOwnerId" TEXT,
    "toOwnerId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'assign',
    CONSTRAINT "CustomerOwnerLog_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "CustomerOwnerLog_customerId_idx" ON "CustomerOwnerLog"("customerId");
