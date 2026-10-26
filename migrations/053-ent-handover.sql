-- 企业版「交接中」（2026-10-26，测试清单 D10）：离职交接、转让客户发起后先记一行，接手人确认了才真转。
-- 说明见 prisma/schema.prisma 的 EntHandover。只在企业版（CRM_ENTERPRISE=1）且「交接要接手人确认」规则开着时写；
-- 桌面端、团队版也建这张空表，不读。规矩同 044-ent-org：只加表、IF NOT EXISTS、每次启动整个重跑、不建外键。
CREATE TABLE IF NOT EXISTS "EntHandover" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "byUserId" TEXT NOT NULL,
    "way" TEXT,
    "customerIds" TEXT NOT NULL DEFAULT '[]',
    "counts" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT '待确认',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" DATETIME,
    "doneById" TEXT
);
CREATE INDEX IF NOT EXISTS "EntHandover_toUserId_status_idx" ON "EntHandover"("toUserId", "status");
CREATE INDEX IF NOT EXISTS "EntHandover_fromUserId_status_idx" ON "EntHandover"("fromUserId", "status");
