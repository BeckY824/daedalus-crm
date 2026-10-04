-- 测试账号（2026-10-04）：AI 不限次数、不算进运营台的统计、不触发运营通知。说明见 prisma/control.prisma 的 TestAccount。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。取消测试不删行，只把 on 置 0，log 留着。
CREATE TABLE IF NOT EXISTS "TestAccount" (
    "accountId" TEXT NOT NULL PRIMARY KEY,
    "on" BOOLEAN NOT NULL DEFAULT true,
    "log" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
