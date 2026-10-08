-- 未归属联系人保留独立负责人；旧数据回填在桌面入口与同步回放中执行。
ALTER TABLE "UnassignedContact" ADD COLUMN "ownerId" TEXT;
