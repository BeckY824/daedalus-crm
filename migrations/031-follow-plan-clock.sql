-- NULL为旧未知，false为仅日期，true为明确钟点（包括00:00）。
ALTER TABLE "FollowPlan" ADD COLUMN "plannedHasTime" BOOLEAN;
