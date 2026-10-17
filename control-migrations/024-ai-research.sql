-- AI 联网背调（2026-10-16）：一次背调一行。规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
--
-- 这张表同时就是 10-14 记账方案里要给账本加的那几列（searches / pages / runId）：
-- 原计划加在 AiCharge 上，但控制面迁移不能改表（SQLite 没有 ADD COLUMN IF NOT EXISTS，
-- 而这个目录每次启动整个重跑），所以单独一张表，按 runId 和 AiCharge 对得上。
--
-- 为什么要落库而不是放内存：和 AiCharge 同一个理由——这是收费契约。一次背调 6 次 AI，
-- 发版重启把内存清掉的话，要么重扣一遍，要么搜索 / 读页的次数闸整个失效。
--
-- 扣费口径（lib/tenant/credits.ts 的 按背调扣 / 退背调）：
--   开始时一次扣足 units（走我们的模型 6、自己的模型 2），不够就一次都不扣；
--   没跑完 6 步、又是我们这边的原因（failures > 0），或者一条材料都没交出去（hits = 0）：整笔退；
--   用户自己停的、最后一步交出去了（reportAt 有值）：不退。refunded 标记保证只退一次（credits.ts 的 收尾背调）。
CREATE TABLE IF NOT EXISTS "AiResearchRun" (
  "id"         TEXT NOT NULL PRIMARY KEY,
  -- account（桌面端）| workspace（托管版，目前没有这条路，留着和 AiCharge 一个口径）
  "ownerKind"  TEXT NOT NULL,
  "ownerId"    TEXT NOT NULL,
  -- 桌面端给这次背调的编号，同时是这次背调里模型调用带的 X-Question-Id
  "runId"      TEXT NOT NULL,
  -- 这次扣了几次 AI。测试账号是 0（不扣，但要有这一行，搜索 / 读页才认）
  "units"      INTEGER NOT NULL,
  -- 走不走我们的模型：走的话 AiCharge 里同一个 runId 有一行，后面的模型调用不再另扣
  "withModel"  INTEGER NOT NULL,
  -- 服务器真去搜了几次 / 读了几页。上限见 lib/research/types.ts 的 背调上限
  "searches"   INTEGER NOT NULL DEFAULT 0,
  "pages"      INTEGER NOT NULL DEFAULT 0,
  -- 服务器交出去的「有用的东西」：有结果的搜索 + 读成功的页。退不退看它，不听桌面端的
  -- （桌面端可以被改：每次都报「没出报告」就能白拿搜索）。一条材料都没交出去才退
  "hits"       INTEGER NOT NULL DEFAULT 0,
  -- 到现在估计花了多少钱，单位「厘」（0.001 元）：模型网关和搜索接口按 token、搜索次数实时累加（lib/research/price.ts）。
  -- 到了上限（RESEARCH_COST_CAP，默认 4 元）就不再给搜、不再给读
  "costLi"     INTEGER NOT NULL DEFAULT 0,
  -- 我们这边失败过几次（10-16 下午总控定「别让用户为我们的超时买单」）：网关等上游超时 / 上游 5xx、429 / 连不上，
  -- 搜索接口两趟都没搜成。服务器自己记的，桌面端改不了——没跑完时退不退就看它
  "failures"   INTEGER NOT NULL DEFAULT 0,
  -- 最后一步（打分 + 切入建议）的模型调用成功交出去的时刻（桌面端带 X-Research-Stage: approach）。有值 = 6 步跑完了
  "reportAt"   DATETIME,
  -- 整笔退过了没有。标记而不是删行：幂等全靠它
  "refunded"   INTEGER NOT NULL DEFAULT 0,
  -- 收尾时桌面端报的结果：出了报告 1、没出 0、还没收尾 NULL
  "ok"         INTEGER,
  "at"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" DATETIME
);
-- 幂等的依据：同一个 owner 的同一个 runId 只有一行，重复 start 不会重扣
CREATE UNIQUE INDEX IF NOT EXISTS "AiResearchRun_ownerKind_ownerId_runId_key" ON "AiResearchRun"("ownerKind", "ownerId", "runId");
CREATE INDEX IF NOT EXISTS "AiResearchRun_at_idx" ON "AiResearchRun"("at");

-- 背调次数的赠送（2026-10-16 用户定：背调单独计数，和问答的 AI 次数分开记、分开显示，一次背调扣 1 次）。
-- 余额 = 这张表的 amount 之和 − AiResearchRun 里没退的 units 之和（不另开计数器：账就是这两张表，对得上）。
-- 来路两样：运营台手动「背调 +N」（reason = admin）；配置 RESEARCH_SIGNUP_GRANT 的新用户赠送（reason = signup，默认 0 不送）。
-- 只加不减，和 AccountAiGrant 一个规矩；key 唯一，同一份赠送重复发静默跳过。
CREATE TABLE IF NOT EXISTS "ResearchGrant" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "amount"    INTEGER NOT NULL,
  "reason"    TEXT NOT NULL,
  "key"       TEXT NOT NULL,
  "note"      TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "ResearchGrant_key_key" ON "ResearchGrant"("key");
CREATE INDEX IF NOT EXISTS "ResearchGrant_accountId_idx" ON "ResearchGrant"("accountId");
