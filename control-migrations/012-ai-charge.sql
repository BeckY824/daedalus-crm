-- 一个问题只扣一次。规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
--
-- 背景：价格页写着「一次提问算一次」，而代码一直是**按网关请求**扣——
-- agent 回答一个问题要跑好几步（lib/agent/run.ts 的 MAX_STEPS = 6），每步一次请求，
-- 于是「送 30 次」实际只够四五个问题。2026-09-21 实测：6 个提问吃掉 39 次。
-- 这张表是「一个问题」这个单位的落脚处：客户端给每个问题一个 requestId，
-- 同一个 id 的后续步骤不再扣费。
--
-- 为什么要落库而不是放进程内存：这是**收费契约**。托管版一个容器一个进程，
-- 重启（每次发版都有）会把内存里的记录清光，正在回答的那个问题会被重扣一次。
-- 一行几十字节，换一个「重启也不会多收钱」，值。
--
-- refunded：上游失败（超时 / 5xx / 429 / 连不上）时把这一次退还。
-- 标记而不是删行，为的是幂等——同一个问题重试几次都只退一次，删了就没法判断。
CREATE TABLE IF NOT EXISTS "AiCharge" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  -- account（桌面端）| workspace（托管版）
  "ownerKind" TEXT NOT NULL,
  "ownerId"   TEXT NOT NULL,
  -- 客户端给这个问题的编号。同一个问题的每一步都带同一个
  "requestId" TEXT NOT NULL,
  -- 这个问题到现在发起过几次模型调用。封顶见 lib/tenant/credits.ts 的 每问最多步
  "calls"     INTEGER NOT NULL DEFAULT 1,
  -- 退过了没有。退过之后同一个 id 再来算新的一次——他上一次什么都没拿到
  "refunded"  INTEGER NOT NULL DEFAULT 0,
  "at"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- 这一条是幂等的全部依据：同一个 owner 的同一个 requestId 只能有一行
CREATE UNIQUE INDEX IF NOT EXISTS "AiCharge_owner_request_key" ON "AiCharge"("ownerKind", "ownerId", "requestId");
CREATE INDEX IF NOT EXISTS "AiCharge_at_idx" ON "AiCharge"("at");
