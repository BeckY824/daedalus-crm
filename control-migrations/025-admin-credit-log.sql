-- 运营台手动加次数（2026-10-19，~/Opensource_CRM 里总控派的「运营台手动加次数」）：用户私下买了背调次数 / AI 次数，
-- 运营台「次数」页或团队详情页给某个账号 +N。次数本身照旧记在 AccountAiGrant / ResearchGrant（reason = admin），
-- 这张表补上那两张表没有的「谁加的、从哪一页加的」，一次加次一行。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
--
-- key：运营台那一次点击的编号（弹框打开时生成，「admin:」开头），和赠送那一行的 key 是同一个，
-- 唯一索引保证连点、网络重发都只加一次（lib/tenant/admin-credits.ts 的 运营加次）。
CREATE TABLE IF NOT EXISTS "AdminCreditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    -- research（背调次数）| ai（问答的 AI 次数）
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    -- 运营账号的邮箱 / 手机；用网址口令进来的记「口令」
    "by" TEXT NOT NULL,
    "note" TEXT,
    -- 从团队详情页加的记团队编号，「次数」页加的是空
    "teamId" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "AdminCreditLog_key_key" ON "AdminCreditLog"("key");
CREATE INDEX IF NOT EXISTS "AdminCreditLog_accountId_at_idx" ON "AdminCreditLog"("accountId", "at");
CREATE INDEX IF NOT EXISTS "AdminCreditLog_at_idx" ON "AdminCreditLog"("at");
