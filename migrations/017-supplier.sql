-- 供应商档案 + 比价 + 订单的采购（2026-10-03，0.46.15 外贸第 3c 块）。说明见 prisma/schema.prisma 的 Supplier。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
-- 订单的采购放旁表 TradeOrderPurchase、不给 TradeOrder 加列：加列一个文件只能放一句（执行器整份跑，第一句报错就跳过后面），旁表一次说清。
CREATE TABLE IF NOT EXISTS "Supplier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "region" TEXT,
    "contact" TEXT,
    "phone" TEXT,
    "wechat" TEXT,
    "invoice" TEXT,
    "payment" TEXT,
    "rating" TEXT,
    "issues" TEXT,
    "remark" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "SupplierQuote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "opportunityId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "unitPrice" REAL NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "withInvoice" BOOLEAN NOT NULL DEFAULT false,
    "moq" REAL,
    "leadDays" INTEGER,
    "sampleFee" REAL,
    "validUntil" DATETIME,
    "quotedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verdict" TEXT NOT NULL DEFAULT '待定',
    "reason" TEXT,
    CONSTRAINT "SupplierQuote_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE CASCADE,
    CONSTRAINT "SupplierQuote_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "SupplierQuote_opportunityId_idx" ON "SupplierQuote"("opportunityId");
CREATE INDEX IF NOT EXISTS "SupplierQuote_supplierId_idx" ON "SupplierQuote"("supplierId");
CREATE TABLE IF NOT EXISTS "TradeOrderPurchase" (
    "orderId" TEXT NOT NULL PRIMARY KEY,
    "supplierId" TEXT,
    "cost" REAL NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "fxRate" REAL,
    CONSTRAINT "TradeOrderPurchase_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TradeOrder" ("id") ON DELETE CASCADE,
    CONSTRAINT "TradeOrderPurchase_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "TradeOrderPurchase_supplierId_idx" ON "TradeOrderPurchase"("supplierId");
