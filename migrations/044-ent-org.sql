-- 企业版组织架构（2026-10-24）：部门树 + 每人的部门、业务角色、业务线、直属 / 虚线上级。说明见 prisma/schema.prisma 的 EntDept / EntMember。
-- 只在企业版（CRM_ENTERPRISE=1）用；桌面端、团队版也建这两张空表，不读。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。不建外键：同 AuditLog，人删了由应用清。
CREATE TABLE IF NOT EXISTS "EntDept" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "EntDept_parentId_idx" ON "EntDept"("parentId");
CREATE TABLE IF NOT EXISTS "EntMember" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "deptId" TEXT,
    "bizRole" TEXT NOT NULL DEFAULT 'sales',
    "line" TEXT,
    "managerId" TEXT,
    "dottedManagerId" TEXT,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS "EntMember_deptId_idx" ON "EntMember"("deptId");
CREATE INDEX IF NOT EXISTS "EntMember_managerId_idx" ON "EntMember"("managerId");
CREATE INDEX IF NOT EXISTS "EntMember_dottedManagerId_idx" ON "EntMember"("dottedManagerId");
