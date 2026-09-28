-- 每台桌面端装的是什么：系统、芯片、版本号（2026-09-28）。一枚设备令牌一行。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
--
-- 单独一张表而不是给 DeviceToken 加列：这里只能加表。
-- 老版本桌面端不上报，它们在这里没有行，运营台显示「未知」。
CREATE TABLE IF NOT EXISTS "DeviceInfo" (
  "deviceTokenId" TEXT NOT NULL PRIMARY KEY,
  -- darwin | win32 | linux
  "platform"      TEXT NOT NULL,
  -- arm64 | x64 | ia32
  "arch"          TEXT,
  "version"       TEXT,
  "updatedAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
