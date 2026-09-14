-- 托管版：一个工作区用掉了多少次 AI 对话。
--
-- 为什么不是给 Workspace 加一列：control-migrations/ 和 migrations/ 一样，
-- 容器每次启动都整个重跑一遍、不记录执行到哪了。SQLite 没有
-- ADD COLUMN IF NOT EXISTS，加列的写法第二次启动就会失败。
-- 单独一张表可以 CREATE TABLE IF NOT EXISTS，天然幂等。
--
-- 为什么不用内存（lib/ai-quota.ts 那种）：那个限的是「五分钟内别刷爆」，
-- 重启清零正合适。这里限的是「试用期一共送几次」，重启清零等于白送，
-- 必须落库。
CREATE TABLE IF NOT EXISTS "AiUsage" (
  "workspaceId" TEXT NOT NULL PRIMARY KEY,
  "calls"       INTEGER NOT NULL DEFAULT 0,
  "updatedAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
