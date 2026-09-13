import { PrismaClient } from "@/generated/control";

/**
 * 控制面库的客户端：账号、工作区、成员、验证码、邀请。
 *
 * 和业务库分开的两个理由：
 *   1. 租户隔离靠「一个工作区一个库文件」，控制面必须在这些文件之外，否则无从判断谁能进哪个库
 *   2. 备份与迁移的节奏不同——业务库可以按工作区单独导出交还给客户，控制面是我们自己的账本
 * 它不随请求变化，所以是个普通单例，不走 prisma.ts 那个代理。
 */
const globalForControl = globalThis as unknown as {
  control: PrismaClient | undefined;
  controlPragmas: boolean | undefined;
};

export const control =
  globalForControl.control ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (!globalForControl.controlPragmas) {
  globalForControl.controlPragmas = true;
  void (async () => {
    try {
      await control.$queryRawUnsafe("PRAGMA journal_mode = WAL");
      await control.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
      await control.$queryRawUnsafe("PRAGMA synchronous = NORMAL");
    } catch (e) {
      console.error("控制面库设置 pragma 失败：", e);
    }
  })();
}

if (process.env.NODE_ENV !== "production") globalForControl.control = control;
