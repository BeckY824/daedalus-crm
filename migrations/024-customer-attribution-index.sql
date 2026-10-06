-- 客户的「渠道归属指向哪位客户」那一列补索引（2026-10-06 测试分期 B.4 大库实测抓到）。
-- 删一位客户时 SQLite 要按外键找「归属指向他」的客户（ON DELETE SET NULL），这一列没索引就整表扫一遍：
-- 2 万位客户的库里撤销一批 1 万行的导入要 2 分钟、批量删客户同样慢。说明见 prisma/schema.prisma 的 Customer。
-- 规矩同前：只加索引、IF NOT EXISTS、每次启动整个重跑。
CREATE INDEX IF NOT EXISTS "Customer_attributionCustomerId_idx" ON "Customer"("attributionCustomerId");
