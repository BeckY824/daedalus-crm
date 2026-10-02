-- 运营台回复反馈（2026-10-02）：在运营台写，用邮件发到对方邮箱，这里留一份底。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。014 被 whatsapp-local 分支占着。
--
-- 单独一张表而不是给 Feedback 加列：控制面只能加表。一条反馈可以来回好几封。
CREATE TABLE IF NOT EXISTS "FeedbackReply" (
  "id"         TEXT NOT NULL PRIMARY KEY,
  "feedbackId" TEXT NOT NULL,
  "at"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- 发到哪个邮箱
  "to"         TEXT NOT NULL,
  "body"       TEXT NOT NULL,
  -- 谁回的：运营账号的邮箱，用网址口令进来的记「口令」
  "by"         TEXT
);
CREATE INDEX IF NOT EXISTS "FeedbackReply_feedbackId_idx" ON "FeedbackReply"("feedbackId");
