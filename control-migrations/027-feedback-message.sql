-- 反馈的一整串往来（2026-10-19）：运营台的回复进桌面端应用，用户在应用里「接着说」也挂在同一条反馈下面。
-- 原来回复只走邮件（015 的 FeedbackReply），没配 SMTP、或者对方是手机号注册的，就完全回不到。
-- 单独一张表而不是给 FeedbackReply 加列：控制面只能加表。规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
CREATE TABLE IF NOT EXISTS "FeedbackMessage" (
  "id"         TEXT NOT NULL PRIMARY KEY,
  "feedbackId" TEXT NOT NULL,
  "at"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- team = 我们回的；user = 用户在应用里接着说
  "side"       TEXT NOT NULL,
  "body"       TEXT NOT NULL,
  -- 谁回的：运营账号的邮箱 / 「口令」；用户那条是 null
  "by"         TEXT,
  -- 勾了「同时发邮件」：发到哪个邮箱，发出去了没（1 / 0）。没要发都是 null
  "emailTo"    TEXT,
  "emailOk"    BOOLEAN,
  -- 桌面端生成的一枚：没收到回音重发同一条，不会落两行
  "clientKey"  TEXT
);
CREATE INDEX IF NOT EXISTS "FeedbackMessage_feedbackId_idx" ON "FeedbackMessage"("feedbackId");
