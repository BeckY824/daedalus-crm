-- 企业版沟通标记（2026-10-26）：每条项目沟通记下「记的时候项目在哪个阶段」+「客户是否明确回复」。说明见 prisma/schema.prisma 的 EntFollowUpMark。
-- 只在企业版（CRM_ENTERPRISE=1）记项目沟通 / 建档向导时写；「有效线索要至少一条有效沟通」按 replied = true 数。
-- 桌面端、团队版也建这张空表，不读不写。规矩同 044-ent-org：只加表、IF NOT EXISTS、每次启动整个重跑、不建外键、不改老数据。
CREATE TABLE IF NOT EXISTS "EntFollowUpMark" (
    "followUpId" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "replied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "EntFollowUpMark_projectId_idx" ON "EntFollowUpMark"("projectId");
