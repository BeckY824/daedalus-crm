-- 邮箱 / 微信 / 阿里国际站 ID 查重的表达式索引（D-16 一次导入上万位老客户，2026-10-25）。说明见 src/lib/email-dedupe.ts 的「按档案格找」。
-- 没电话的行按这三格认人，库那一侧是 lower(trim(列)) 再比；没索引的话导入每一片、落库每一行都把 CustomerExtra 整张扫一遍，
-- 库越大越慢。式子必须和 按档案格找 的 SQL 原样一致（tests/import-10k-timing.test.ts 钉着查询计划）。
-- 规矩同前：只加索引、IF NOT EXISTS、每次启动整个重跑。alibabaId 列是 040 加的，按文件名顺序已经在了。
CREATE INDEX IF NOT EXISTS "CustomerExtra_emailKey_idx" ON "CustomerExtra"(lower(trim("email")));
CREATE INDEX IF NOT EXISTS "CustomerExtra_wechatKey_idx" ON "CustomerExtra"(lower(trim("wechat")));
CREATE INDEX IF NOT EXISTS "CustomerExtra_alibabaIdKey_idx" ON "CustomerExtra"(lower(trim("alibabaId")));
