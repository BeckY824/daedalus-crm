-- 跟进记录的原文（速记解析时粘贴的聊天记录）。
-- 全新安装由 schema.sql 建全，这里只为存量库补表；全部 IF NOT EXISTS，重复执行无副作用。
-- 与 FollowUp 级联删除：跟进记录删了，原文没有单独存在的意义。主键不会改，不需要 ON UPDATE 子句。

CREATE TABLE IF NOT EXISTS "FollowUpSource" (
    "followUpId" TEXT NOT NULL PRIMARY KEY,
    "text" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FollowUpSource_followUpId_fkey" FOREIGN KEY ("followUpId") REFERENCES "FollowUp" ("id") ON DELETE CASCADE
);
