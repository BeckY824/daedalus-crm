-- 团队版项目模式 1a（2026-10-23）：项目、项目组、组员角色字典、异常类别字典、节点变更、沟通挂项目、客户建档人。说明见 prisma/schema.prisma 的 Project。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑；现有表一列不动。默认 4 个组员角色、2 个异常类别由代码第一次读时补（这里不许 INSERT）。
-- 指向人的列不建外键（同 TradeOrder.ownerId），改身份时按 src/lib/sync/tables.ts 的 指向人的列 一起改。
CREATE TABLE IF NOT EXISTS "ProjectRole" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProjectRole_name_key" ON "ProjectRole"("name");
CREATE TABLE IF NOT EXISTS "ProjectExceptionCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProjectExceptionCategory_name_key" ON "ProjectExceptionCategory"("name");
CREATE TABLE IF NOT EXISTS "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "contactId" TEXT,
    "ownerId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT '线索',
    "node" TEXT NOT NULL DEFAULT '潜客培育',
    "result" TEXT,
    "exceptionCategoryId" TEXT,
    "exceptionReason" TEXT,
    "pooledAt" DATETIME,
    "balanceSettled" BOOLEAN NOT NULL DEFAULT false,
    "balanceSettledById" TEXT,
    "balanceSettledAt" DATETIME,
    "acceptancePassed" BOOLEAN NOT NULL DEFAULT false,
    "acceptancePassedById" TEXT,
    "acceptancePassedAt" DATETIME,
    "amount" REAL NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "remark" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "closedAt" DATETIME,
    CONSTRAINT "Project_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Project_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Project_exceptionCategoryId_fkey" FOREIGN KEY ("exceptionCategoryId") REFERENCES "ProjectExceptionCategory" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Project_customerId_idx" ON "Project"("customerId");
CREATE INDEX IF NOT EXISTS "Project_ownerId_idx" ON "Project"("ownerId");
CREATE INDEX IF NOT EXISTS "Project_pooledAt_idx" ON "Project"("pooledAt");
CREATE TABLE IF NOT EXISTS "ProjectMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT,
    "inviteStatus" TEXT NOT NULL DEFAULT 'JOINED',
    "invitedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectMember_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "ProjectRole" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ProjectMember_userId_idx" ON "ProjectMember"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "ProjectMember_projectId_userId_key" ON "ProjectMember"("projectId", "userId");
CREATE TABLE IF NOT EXISTS "ProjectNodeLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fromPhase" TEXT,
    "fromNode" TEXT,
    "fromResult" TEXT,
    "toPhase" TEXT NOT NULL,
    "toNode" TEXT NOT NULL,
    "toResult" TEXT,
    "reason" TEXT,
    "categoryId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'node',
    "fromOwnerId" TEXT,
    "toOwnerId" TEXT,
    CONSTRAINT "ProjectNodeLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ProjectNodeLog_projectId_at_idx" ON "ProjectNodeLog"("projectId", "at");
CREATE TABLE IF NOT EXISTS "FollowUpProject" (
    "followUpId" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "node" TEXT NOT NULL,
    CONSTRAINT "FollowUpProject_followUpId_fkey" FOREIGN KEY ("followUpId") REFERENCES "FollowUp" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FollowUpProject_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "FollowUpProject_projectId_idx" ON "FollowUpProject"("projectId");
CREATE TABLE IF NOT EXISTS "CustomerCreator" (
    "customerId" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerCreator_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
