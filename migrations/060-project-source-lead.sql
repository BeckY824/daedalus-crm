-- 项目来源线索（2026-10-28，团队版项目模式，照企业版 10-26 验收 #13）。说明见 prisma/schema.prisma 的 Project.sourceLeadId。
-- 加列单独一个文件（README 第 4 条）：第二次执行抛 duplicate column name，各 runner 当预期跳过。老项目全是空 = 不是线索转来的。
ALTER TABLE "Project" ADD COLUMN "sourceLeadId" TEXT;
CREATE INDEX IF NOT EXISTS "Project_sourceLeadId_idx" ON "Project"("sourceLeadId");
