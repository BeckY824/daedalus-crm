-- 首页对话的历史：对话、消息、项目。
--
-- 在这之前首页那串问答只活在内存里（lib/home-thread.ts），刷新即清，
-- 也开不出第二个对话——问过的东西没有任何地方能翻回来。
--
-- **只有自己看得见**：所有读取按 ownerId 过滤（桌面端的库本来就在本人机器上）。
-- 提问时带的附件原文不入库，仍然只在内存里，见 components/AskFiles.tsx。
--
-- 列一次留全：这个目录只能加表不能加列（SQLite 没有 ADD COLUMN IF NOT EXISTS，
-- 而它每次容器启动整个重跑），所以 projectId / pinnedAt / archivedAt 现在就建好，
-- 界面以后再长出来。不留的话下一版就只能走 REBUILD_DB=1。
--
-- 不与 User 建外键：成员被删不该带走他问过的东西，也不该让删人这件事卡在这儿。

CREATE TABLE IF NOT EXISTS "AiProject" (
    "id"         TEXT NOT NULL PRIMARY KEY,
    "name"       TEXT NOT NULL,
    -- 项目说明。和业务简介一样会注入提示词：一段全局，一段局部
    "brief"      TEXT,
    "ownerId"    TEXT NOT NULL,
    "archivedAt" DATETIME,
    "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "AiProject_ownerId_idx" ON "AiProject"("ownerId");

CREATE TABLE IF NOT EXISTS "AiConversation" (
    "id"          TEXT NOT NULL PRIMARY KEY,
    "title"       TEXT NOT NULL,
    "ownerId"     TEXT NOT NULL,
    "projectId"   TEXT,
    "pinnedAt"    DATETIME,
    "archivedAt"  DATETIME,
    -- 排序按它，不按 updatedAt：重命名不该让一条老对话跳到最前面
    "lastAskedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "AiConversation_ownerId_lastAskedAt_idx" ON "AiConversation"("ownerId", "lastAskedAt");
CREATE INDEX IF NOT EXISTS "AiConversation_projectId_idx" ON "AiConversation"("projectId");

CREATE TABLE IF NOT EXISTS "AiMessage" (
    "id"             TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    -- user | assistant
    "role"           TEXT NOT NULL,
    "text"           TEXT NOT NULL,
    "model"          TEXT,
    "ms"             INTEGER,
    -- 工具调用轨迹与涉及到的记录，各存一段 JSON；翻历史时那几行「读了什么」还在
    "steps"          TEXT,
    "refs"           TEXT,
    "createdAt"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation" ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "AiMessage_conversationId_createdAt_idx" ON "AiMessage"("conversationId", "createdAt");
