-- 改密之后作废旧会话用的时间线。规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
CREATE TABLE IF NOT EXISTS "SessionCutoff" (
  "accountId" TEXT NOT NULL PRIMARY KEY,
  "since"     DATETIME NOT NULL
);
