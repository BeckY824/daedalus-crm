-- 阿里国际站 ID（2026-10-21，客户反馈：国际站来的询盘很多只有买家 ID）。说明见 prisma/schema.prisma 的 CustomerExtra.alibabaId。
-- 加列单独一个文件（README 第 4 条）。老数据全是空。
ALTER TABLE "CustomerExtra" ADD COLUMN "alibabaId" TEXT;
