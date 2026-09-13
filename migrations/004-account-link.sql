-- 托管版：把控制面的 Account 映射到这个工作区里的 User。
--
-- 为什么是一张表而不是给 User 加列：migrations/ 每次容器启动都整个重跑一遍，
-- 而 SQLite 没有 ADD COLUMN IF NOT EXISTS，加列的写法第二次启动就会失败。
-- 单独一张表可以 CREATE TABLE IF NOT EXISTS，天然幂等。
-- 顺带把托管版的概念留在业务模型之外：自部署版这张表永远是空的。
CREATE TABLE IF NOT EXISTS "WorkspaceAccount" (
  "userId"    TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "WorkspaceAccount_accountId_idx" ON "WorkspaceAccount"("accountId");
