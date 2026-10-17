-- 客户官网（2026-10-16，0.46.19 外贸基础）。说明见 prisma/schema.prisma 的 CustomerExtra.website。
-- 加列单独一个文件（README 第 4 条）。老数据全是空。
ALTER TABLE "CustomerExtra" ADD COLUMN "website" TEXT;
