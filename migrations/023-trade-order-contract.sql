-- 订单就是一笔签约（2026-10-05，0.46.16 外贸客户建议）：外贸模版下「新建订单」= 登记一笔签约 + 订单号 / 付款方式 / 供应商。
-- 这一列指向那笔签约；签约删了订单跟着没。说明见 prisma/schema.prisma 的 TradeOrder.contractId。
-- 加列：本文件只放这一列和它的索引（见 README 第 4 条）。TradeOrder 是迁移 016 建的表，空库从头跑时它已经在了。
ALTER TABLE "TradeOrder" ADD COLUMN "contractId" TEXT REFERENCES "Contract" ("id") ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "TradeOrder_contractId_key" ON "TradeOrder"("contractId");
