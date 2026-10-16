-- 客户等级 A / B / C / D（2026-10-16，0.46.19 外贸基础）。说明见 prisma/schema.prisma 的 CustomerExtra.level。
-- 加列单独一个文件（README 第 4 条）：第二次执行抛 duplicate column name，各 runner 当预期跳过。老数据全是空 = 没分级。
ALTER TABLE "CustomerExtra" ADD COLUMN "level" TEXT;
CREATE INDEX IF NOT EXISTS "CustomerExtra_level_idx" ON "CustomerExtra"("level");
