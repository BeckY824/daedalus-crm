-- 团队「同事之间互相看得到客户」开关（2026-10-20，客户需求）。整个团队一个开关，默认关，只有老板（建团队的人）能改。
-- 放在中继这边而不是加密的业务配置里：业务员能拉到哪些客户由服务器按范围放行，服务器读不到密文，只能看这张表。
-- 单独一张表而不是给 SyncTeam 加列：控制面只能加表。规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
CREATE TABLE IF NOT EXISTS "SyncTeamShare" (
  "teamId"    TEXT NOT NULL PRIMARY KEY,
  -- 1 = 业务员能看到全队客户、跟进、商机；0 = 只看自己的 + 公海。没有这一行 = 关
  "on"        BOOLEAN NOT NULL DEFAULT 0,
  "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- 谁改的（老板的账号 id）
  "by"        TEXT
);
