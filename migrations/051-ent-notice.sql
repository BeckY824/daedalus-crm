-- 企业版站内提醒（2026-10-26）：自动分配时参与的人都满额，给市场管理、总管理员各一条（三张清单 A8 / 验收 7.6）。
-- 说明见 prisma/schema.prisma 的 EntNotice。桌面端、团队版也建这张空表，不读。
-- 规矩同 044-ent-org：只加表、IF NOT EXISTS、每次启动整个重跑、不建外键。
CREATE TABLE IF NOT EXISTS "EntNotice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "times" INTEGER NOT NULL DEFAULT 1,
    "readAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS "EntNotice_userId_readAt_idx" ON "EntNotice"("userId", "readAt");
