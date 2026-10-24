-- 商机 / 订单的附件（2026-10-22，D-24）。说明见 prisma/schema.prisma 的 Attachment。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。不建外键：商机删了又撤销时编号不变，附件跟着回来。
CREATE TABLE IF NOT EXISTS "Attachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "opportunityId" TEXT,
    "orderId" TEXT,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sha256" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "Attachment_opportunityId_idx" ON "Attachment"("opportunityId");
CREATE INDEX IF NOT EXISTS "Attachment_orderId_idx" ON "Attachment"("orderId");
