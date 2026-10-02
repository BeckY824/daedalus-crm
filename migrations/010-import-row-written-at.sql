-- 导入的每一行记下「写完那一刻客户档案的 updatedAt」（2026-10-02，排查 A7 旁边那条「待确认」）。
-- 撤销时拿它和客户现在的 updatedAt 精确比，判断导入之后有没有人改过。
-- 原来用「比批次开始时刻晚 2 秒」：行一多，后面的行写进去时早过了 2 秒，撤销时被误判成「有人改过」、撤不掉。
-- 老批次没有这一列的值，撤销时照旧按批次时刻 + 2 秒算。
-- 加列的迁移单独一个文件、只放 ADD COLUMN（README 第 4 条）。SQLite 加列不能带 CURRENT_TIMESTAMP 默认值，所以可空、由代码写。
ALTER TABLE "ImportRow" ADD COLUMN "writtenAt" DATETIME;
