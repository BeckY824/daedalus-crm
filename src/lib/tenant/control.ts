import { PrismaClient } from "@/generated/control";

/**
 * 控制面库的客户端：账号、工作区、成员、验证码、邀请。
 *
 * 和业务库分开的两个理由：
 *   1. 租户隔离靠「一个工作区一个库文件」，控制面必须在这些文件之外，否则无从判断谁能进哪个库
 *   2. 备份与迁移的节奏不同——业务库可以按工作区单独导出交还给客户，控制面是我们自己的账本
 *
 * **懒加载**：自部署（单租户）根本没有控制面库，也不会设 CONTROL_DATABASE_URL。
 * 早先是模块加载即实例化，结果每个自部署实例启动时都会打一串
 * 「Environment variable not found」的报错——功能没事，但没人知道那是无害的。
 * 现在只有真的用到时才建，单租户跑一辈子也碰不到它。
 */
const globalForControl = globalThis as unknown as {
  control: PrismaClient | undefined;
  controlPragmas: boolean | undefined;
};

function create(): PrismaClient {
  const client =
    globalForControl.control ??
    new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    });

  if (!globalForControl.controlPragmas) {
    globalForControl.controlPragmas = true;
    void (async () => {
      try {
        await client.$queryRawUnsafe("PRAGMA journal_mode = WAL");
        await client.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
        await client.$queryRawUnsafe("PRAGMA synchronous = NORMAL");
      } catch (e) {
        console.error("控制面库设置 pragma 失败：", e);
      }
    })();
  }

  if (process.env.NODE_ENV !== "production") globalForControl.control = client;
  return client;
}

/**
 * 取控制面客户端。第一次用到时才真的建连接。
 *
 * 导出成代理而不是函数，是为了让调用方照旧写 `control.workspace.findMany()`，
 * 不必每处都记得先调一次 getControl()。
 */
export const control: PrismaClient = new Proxy({} as PrismaClient, {
  get(_t, prop) {
    const client = create();
    const v = Reflect.get(client, prop, client);
    return typeof v === "function" ? v.bind(client) : v;
  },
});
