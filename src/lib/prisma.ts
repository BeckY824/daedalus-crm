import { PrismaClient } from "@/generated/prisma";
import { tenantClient } from "./tenant/clients";
import { multiTenant } from "./tenant/context";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pragmasApplied: boolean | undefined;
};

/**
 * 默认库。自部署（单租户）时全程用它；托管版里它只承载不属于任何工作区的东西。
 */
const defaultClient =
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
      await defaultClient.$queryRawUnsafe("PRAGMA journal_mode = WAL");
      await defaultClient.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
      await defaultClient.$queryRawUnsafe("PRAGMA synchronous = NORMAL");
    } catch (e) {
      console.error("设置 SQLite pragma 失败：", e);
    }
  })();
}

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = defaultClient;

/**
 * 业务代码用的数据库入口。
 *
 * 它是个代理：每次取属性时先问「这个请求属于哪个工作区」，有就用那个工作区的客户端，
 * 没有就用默认库。托管版靠它做租户隔离，自部署时这一层等于不存在。
 *
 * 为什么用代理而不是让调用方传客户端：34 个文件在用这个导出，逐个改签名既啰嗦又容易漏；
 * 漏一处就是一个租户读到另一个租户数据的事故。代理让「忘了处理多租户」这件事不可能发生。
 *
 * 注意：解析发生在**取属性那一刻**。所以不要把 `prisma.customer` 存成模块级变量，
 * 那样会把某一次请求的客户端固化下来。按 `prisma.customer.findMany()` 这样连着用就对了。
 */
function resolve(target: PrismaClient): PrismaClient {
  const client = tenantClient();
  if (client) return client;
  // 托管版里「没有工作区上下文」不是可以将就的情况：将就一下就是把某个租户的写入
  // 落到默认库，或者把默认库的数据读给别人看。宁可这个请求 500，也不能静默串库。
  if (multiTenant()) {
    throw new Error("多租户模式下访问了数据库但没有工作区上下文：入口处应先调用 requireUser()");
  }
  return target;
}

export const prisma: PrismaClient = new Proxy(defaultClient, {
  get(target, prop, receiver) {
    const client = resolve(target);
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
  set(target, prop, value) {
    const client = resolve(target);
    return Reflect.set(client, prop, value, client);
  },
  has(target, prop) {
    return Reflect.has(resolve(target), prop);
  },
});

/** 明确要默认库时用它（控制面之外的少数场景，比如单租户的建库脚本） */
export { defaultClient };
