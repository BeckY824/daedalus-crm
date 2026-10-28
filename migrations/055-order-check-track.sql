-- 外贸订单的样品 / 验货 / 海运（0.46.30 D-44 / D-45 / D-46）。说明见 prisma/schema.prisma 的 TradeOrderCheck、TradeOrderTrack。
-- 不往 12 个节点里插、不给 TradeOrder 加列：新信息放新表，挂在订单上，订单删了跟着删。
CREATE TABLE IF NOT EXISTS "TradeOrderCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "at" DATETIME,
    "result" TEXT,
    "issue" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TradeOrderCheck_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TradeOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "TradeOrderCheck_orderId_idx" ON "TradeOrderCheck"("orderId");
CREATE TABLE IF NOT EXISTS "TradeOrderTrack" (
    "orderId" TEXT NOT NULL PRIMARY KEY,
    "sampleNa" BOOLEAN NOT NULL DEFAULT false,
    "vessel" TEXT,
    "container" TEXT,
    "eta" DATETIME,
    "ata" DATETIME,
    CONSTRAINT "TradeOrderTrack_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TradeOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
