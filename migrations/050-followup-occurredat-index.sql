-- 跟进记录页按发生时间倒序取最近 300 条（follow-ups/page.tsx）。
-- FollowUp 上只有 (customerId, occurredAt) 和 type 两个索引，不按客户筛的时候用不上，
-- 每次打开都要把整张表排一遍：企业版 20 万条跟进实测这一句 10 ms，且占着读连接。
-- 有了 occurredAt 直接倒着读前 300 行，0.3 ms；按日期筛也能走它。
CREATE INDEX IF NOT EXISTS "FollowUp_occurredAt_idx" ON "FollowUp"("occurredAt");
