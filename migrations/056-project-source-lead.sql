-- 项目的来源线索（2026-10-26，企业版线索转项目）。说明见 prisma/schema.prisma 的 Project.sourceLeadId。
-- 加列单独一个文件（README 第 4 条），配套索引同文件。老项目全是空 = 不是从线索转来的（建档向导建的、或这一版之前转的）。
ALTER TABLE "Project" ADD COLUMN "sourceLeadId" TEXT;
CREATE INDEX IF NOT EXISTS "Project_sourceLeadId_idx" ON "Project"("sourceLeadId");
