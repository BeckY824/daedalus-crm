-- 托管版：一台机器的注册赠送被哪个账号领走了。
-- 规矩同前：只加表、IF NOT EXISTS、每次启动整个重跑。
--
-- 为什么要有这张表：免费次数原来只按账号算（幂等键 `<accountId>:signup`），
-- 同一台电脑上注册第二个账号就又是一份 30 次。这张表给账号那一路补上机器这一维——
-- 一台机器的注册赠送只发得出去一次。规则实现见 src/lib/tenant/credits.ts。
--
-- machineHash 是硬件 UUID 加盐 sha256 之后的 64 位十六进制，客户端算好再传上来
-- （desktop/machine.js）。**这里不存任何可还原的硬件标识符。**
CREATE TABLE IF NOT EXISTS "MachineSignup" (
  "machineHash" TEXT NOT NULL PRIMARY KEY,
  "accountId"   TEXT NOT NULL,
  "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "MachineSignup_accountId_idx" ON "MachineSignup"("accountId");
