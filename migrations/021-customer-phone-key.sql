-- 号码查重的表达式索引（R-067 / R-069，2026-10-04）。说明见 src/lib/phone-dedupe.ts 的「号键查库」。
-- 老库里的号码带着空格、横杠、全角横杠（规整之前的写法，不回填）；查重时库那一侧也去掉分隔符再比，
-- 有这个索引就是一次索引查找，不用每录一位客户扫一遍全表。式子必须和 号键SQL('"phone"') 原样一致（tests/r067-phone-key.test.ts 钉着）。
-- 规矩同前：只加索引、IF NOT EXISTS、每次启动整个重跑。
-- 式子最多 20 层 replace()：SQLite 3.46 以前只吃 29 层，超了老 SQLite 连整个库都打不开（第一版 31 层撞上过，这一版没发出去过就改了）。
CREATE INDEX IF NOT EXISTS "Customer_phoneKey_idx" ON "Customer"(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace("phone", '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), ' ', ''), '　', ''), '-', ''), '－', ''), '—', ''), '(', ''), ')', ''), '（', ''), '）', ''), '+', ''));
