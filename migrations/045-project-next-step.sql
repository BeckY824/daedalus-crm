-- 项目下一步时间（2026-10-24，企业版超时回收）。说明见 prisma/schema.prisma 的 Project.nextStepAt。
-- 加列单独一个文件（README 第 4 条）：第二次执行抛 duplicate column name，各 runner 当预期跳过。老数据全是空 = 没填过，按节点时长算。
ALTER TABLE "Project" ADD COLUMN "nextStepAt" DATETIME;
