-- 外贸订单 + 12 节点 + 单据 + 跟进挂节点（2026-10-03，0.46.15 外贸第 3a 块）。说明见 prisma/schema.prisma 的 TradeOrder。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。表名不叫 Order：那是 SQL 关键字。
CREATE TABLE IF NOT EXISTS "TradeOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "no" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "ownerId" TEXT NOT NULL,
    "amount" REAL NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "incoterm" TEXT,
    "payment" TEXT,
    "depositDue" REAL NOT NULL DEFAULT 0,
    "depositPaid" REAL NOT NULL DEFAULT 0,
    "depositAt" DATETIME,
    "balancePaid" REAL NOT NULL DEFAULT 0,
    "balanceAt" DATETIME,
    "remark" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TradeOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE,
    CONSTRAINT "TradeOrder_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "TradeOrder_customerId_idx" ON "TradeOrder"("customerId");
CREATE INDEX IF NOT EXISTS "TradeOrder_opportunityId_idx" ON "TradeOrder"("opportunityId");
CREATE TABLE IF NOT EXISTS "TradeOrderNode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "dueAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT '未开始',
    "doneAt" DATETIME,
    CONSTRAINT "TradeOrderNode_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TradeOrder" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "TradeOrderNode_orderId_idx_key" ON "TradeOrderNode"("orderId", "idx");
CREATE TABLE IF NOT EXISTS "TradeOrderDoc" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT '未收',
    CONSTRAINT "TradeOrderDoc_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TradeOrder" ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "TradeOrderDoc_orderId_idx" ON "TradeOrderDoc"("orderId");
CREATE TABLE IF NOT EXISTS "FollowUpOrder" (
    "followUpId" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "nodeIdx" INTEGER NOT NULL,
    CONSTRAINT "FollowUpOrder_followUpId_fkey" FOREIGN KEY ("followUpId") REFERENCES "FollowUp" ("id") ON DELETE CASCADE,
    CONSTRAINT "FollowUpOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TradeOrder" ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "FollowUpOrder_orderId_idx" ON "FollowUpOrder"("orderId");
