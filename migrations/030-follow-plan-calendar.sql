-- 不推断旧记录原始选择，仅新日期计划保存日历日。
ALTER TABLE "FollowPlan" ADD COLUMN "plannedOn" TEXT;
