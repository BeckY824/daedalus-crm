-- 跟进记录页按发生时间倒序取最近 300 条（follow-ups/page.tsx）。
-- FollowUp 上只有 (customerId, occurredAt) 和 type 两个索引，不按客户筛的时候用不上，
-- 每次打开都要把整张表排一遍：企业版 20 万条跟进实测这一句 10 ms，且占着读连接。
-- 有了 occurredAt 直接倒着读前 300 行，0.3 ms；按日期筛也能走它。
CREATE INDEX IF NOT EXISTS "FollowUp_occurredAt_idx" ON "FollowUp"("occurredAt");
-- 只建上面那条的话，SQLite 没有 ANALYZE 统计，按成员筛也会被带去顺着 occurredAt 扫全表再挑人：
-- 跟进少的成员从 0.01 s 变成 0.05–0.24 s。补一条 (ownerId, occurredAt)，按成员筛直接 SEARCH。
CREATE INDEX IF NOT EXISTS "FollowUp_ownerId_occurredAt_idx" ON "FollowUp"("ownerId", "occurredAt");
