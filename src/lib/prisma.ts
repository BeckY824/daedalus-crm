import { PrismaClient } from "@/generated/prisma";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pragmasApplied: boolean | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

/**
 * SQLite 默认是 delete 日志模式：写入时独占整个库，读操作被阻塞；
 * 且 busy_timeout 为 0，碰到锁立即抛错而不等待。
 * 多人同时使用时，一方保存的瞬间另一方就可能拿到 "database is locked"。
 *
 * WAL 模式让读写互不阻塞，busy_timeout 再给一个重试窗口兜底。
 * journal_mode 写入库文件本身、只需设置一次；busy_timeout 是连接级的，
 * 每个新连接都要设，因此放在这里随客户端初始化执行。
 */
if (!globalForPrisma.pragmasApplied) {
  globalForPrisma.pragmasApplied = true;
  void (async () => {
    try {
      // 这几条 PRAGMA 都会返回结果行，必须用 queryRaw；
      // executeRaw 在 SQLite 下遇到返回值会直接报错
      await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL");
      await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
      await prisma.$queryRawUnsafe("PRAGMA synchronous = NORMAL");
    } catch (e) {
      console.error("设置 SQLite pragma 失败：", e);
    }
  })();
}

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
