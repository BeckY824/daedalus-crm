-- 客户列表默认按建档时间倒序、同一时刻按 id 倒序翻页（customers/page.tsx）。
-- 原来 Customer 上没有 createdAt 的索引，每次打开客户列表都要把整张表排一遍再取 20 行：
-- 企业版 10 万客户实测这一句 21 ms，且占着读连接，30 人同时用时整站排队。
-- 有了 (createdAt, id) 直接按索引倒着读前 20 行，0.01 ms；翻到第 100 页也一样。
CREATE INDEX IF NOT EXISTS "Customer_createdAt_id_idx" ON "Customer"("createdAt", "id");
