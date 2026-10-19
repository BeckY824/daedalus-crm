-- 跨成员查重（2026-10-19，用户拍板「S2 跨成员查重：做」）：范围同步下业务员库里没有同事的客户，录到同事已有的号码查不出来。
-- 服务端替全队记一份索引：号码 / 邮箱 / 微信号规整后用团队钥匙做的 HMAC（hex）→ 哪位客户、封好的客户名。
-- 不存明文；负责人不存，查的时候按 SyncScopedRecord 里这位客户当前的归属算（转交、进公海、删除都跟着变）。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
CREATE TABLE IF NOT EXISTS "SyncDedupeKey" (
    "teamId" TEXT NOT NULL,
    -- 客户 id（SyncScopedRecord 的键是 Customer:<它>）
    "recordKey" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    -- 封哈希时的团队钥匙编号；换钥匙后只认当前编号
    "epoch" INTEGER NOT NULL,
    -- 封好的客户名（团队钥匙），只回给问的人
    "label" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("teamId", "recordKey", "hash")
);
CREATE INDEX IF NOT EXISTS "SyncDedupeKey_teamId_hash_idx" ON "SyncDedupeKey"("teamId", "hash");
