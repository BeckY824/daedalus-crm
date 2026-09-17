-- 用户反馈。桌面端和托管版都发到这里（自部署的开源版不发，按钮去 GitHub issues）。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
--
-- 存在控制面而不是业务库：反馈属于我们，不属于任何一个工作区，
-- 而且桌面端本地模式根本没有我们能读的业务库——它的库在用户自己机器上。
CREATE TABLE IF NOT EXISTS "Feedback" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "at"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- desktop | web
  "source"    TEXT NOT NULL DEFAULT 'web',
  "body"      TEXT NOT NULL,
  -- 发的时候人在哪一页，如 /customers。定位「哪儿不好用」的第一条线索
  "path"      TEXT,
  "version"   TEXT,
  "platform"  TEXT,
  -- 谁发的：桌面端是云端账号 id，网页是工作区 + 成员名
  "accountId" TEXT,
  "who"       TEXT,
  "handled"   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "Feedback_at_idx" ON "Feedback"("at");
