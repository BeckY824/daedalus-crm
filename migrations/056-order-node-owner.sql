-- 订单节点负责人（0.46.30 D-47）。说明见 prisma/schema.prisma 的 TradeOrderNodeOwner。
-- 一个节点一行；userId 不建外键（同 TradeOrder.ownerId），改身份走 sync/tables.ts 的 指向人的列。
CREATE TABLE IF NOT EXISTS "TradeOrderNodeOwner" (
    "nodeId" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    CONSTRAINT "TradeOrderNodeOwner_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "TradeOrderNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "TradeOrderNodeOwner_userId_idx" ON "TradeOrderNodeOwner"("userId");
