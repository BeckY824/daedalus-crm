-- 演示区按浏览器记次数（取代原来的演示码）。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
-- 原来的 ActivationCode / DemoCode / TrialMasterCode 三张表已经不再使用，
-- 但**不删**：删表是不可逆的，而留着几张空表不花什么钱。
CREATE TABLE IF NOT EXISTS "DemoVisitor" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "calls"     INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
