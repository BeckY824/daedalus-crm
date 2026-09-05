-- 系统设置键值表：AI 接入、业务术语等在界面里改的配置。
-- 全新安装由 schema.sql 建全，这里只为存量库补表；全部 IF NOT EXISTS，重复执行无副作用。

CREATE TABLE IF NOT EXISTS "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
