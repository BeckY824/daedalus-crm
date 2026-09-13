import { PrismaClient } from "@/generated/prisma";
import { workspaceClient } from "./tenant/clients";
import { currentTenant, multiTenant } from "./tenant/context";
import { resolveCurrentTenant } from "./tenant/resolve";
import { TrialExpiredError } from "./tenant/guard";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pragmasApplied: boolean | undefined;
};

/**
 * 默认库。自部署（单租户）时全程用它；托管版里谁都不该碰到它。
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

/** Prisma 里会改数据的方法。漏一个就等于给到期工作区开了一扇后门 */
const WRITE_METHODS = new Set([
  "create", "createMany", "createManyAndReturn",
  "update", "updateMany", "updateManyAndReturn",
  "upsert", "delete", "deleteMany",
]);

/** 顶层的写入口：裸 SQL 绕得过模型层，同样要拦 */
const RAW_WRITES = new Set(["$executeRaw", "$executeRawUnsafe"]);

/**
 * 这一次调用该用哪个客户端。
 *
 * 托管版里解析是异步的（读 cookie、验 JWT、查成员关系），所以它只能发生在
 * **方法被调用的那一刻**，而不是取属性的时候——好在方法本来就返回 Promise。
 * 为什么不用 AsyncLocalStorage、也不用 React 的 cache()，见 tenant/resolve.ts。
 */
async function clientForCall(write: boolean): Promise<PrismaClient> {
  if (!multiTenant()) return defaultClient;

  // 测试和少数服务端路径会显式 runWithTenant，有就优先用
  const ctx = currentTenant() ?? (await resolveCurrentTenant());
  if (!ctx) {
    // 托管版里「没有工作区」不是可以将就的情况：将就一下就是把某个租户的写入
    // 落到默认库，或者把默认库的数据读给别人看。宁可这个请求 500，也不能静默串库。
    throw new Error("多租户模式下访问了数据库但解析不到工作区：会话缺失或已失效");
  }
  if (write && !ctx.writable) throw new TrialExpiredError();
  return workspaceClient(ctx.dbFile);
}

/**
 * 把一个模型委托（prisma.customer 这种）包一层：每次方法调用先解析工作区，
 * 写方法再过一道试用期检查。
 *
 * 拦在这里而不是逐个 Server Action 里加：读写有上百处，漏一处不是小 bug——
 * 要么串库，要么到期还能写。放在离数据最近的地方，忘不掉。
 */
function modelProxy(model: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, method) {
        if (typeof method !== "string") return undefined;
        return (...args: unknown[]) => {
          const write = WRITE_METHODS.has(method);
          return clientForCall(write).then((c) => {
            const delegate = (c as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)[model];
            return delegate[method](...args);
          });
        };
      },
    },
  );
}

export const prisma: PrismaClient = new Proxy(defaultClient, {
  get(target, prop) {
    if (typeof prop !== "string") return Reflect.get(target, prop, target);

    // 自部署：这一层完全不存在，行为与改造前一致
    if (!multiTenant()) {
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    }

    // $transaction / $queryRaw / $executeRaw…：同样在调用时解析
    if (prop.startsWith("$")) {
      return (...args: unknown[]) =>
        clientForCall(RAW_WRITES.has(prop)).then((c) => {
          const fn = (c as unknown as Record<string, (...a: unknown[]) => unknown>)[prop];
          return fn.apply(c, args);
        });
    }
    if (prop.startsWith("_")) return Reflect.get(target, prop, target);
    return modelProxy(prop);
  },
});

/** 明确要默认库时用它（单租户的脚本、种子数据） */
export { defaultClient };
