-- 实际完成时间。旧计划没有可靠完成时间，保留NULL，不拿计划时间或最后修改时间代替。
ALTER TABLE "FollowPlan" ADD COLUMN "doneAt" DATETIME;
