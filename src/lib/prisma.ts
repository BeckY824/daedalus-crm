import { PrismaClient } from "@/generated/prisma";
import { workspaceClient } from "./tenant/clients";
import { currentTenant, multiTenant } from "./tenant/context";
import { resolveCurrentTenant } from "./tenant/resolve";
import { TrialExpiredError } from "./tenant/guard";
import { 加上限定 } from "./team-scope";
import { 企业版 } from "./enterprise/switch";
import { 单连接 } from "./sqlite-url";
import { 读通道, 读通道开着, 读方法, 取SQL, 只读SQL, 只读查询, 关读通道 } from "./read-pool";

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
    // 只开 1 个连接：多个连接在 Linux 上会让交互式事务和别的写库互相卡死（见 lib/sqlite-url）
    datasourceUrl: 单连接(process.env.DATABASE_URL),
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
 * 团队版业务员只看自己的（lib/team-scope.ts）：读、改、删都加一句 where。桌面端本地模式生效；
 * 企业版（CRM_ENTERPRISE=1）的「按组织架构看客户」也走这一层。别处 限定的我() 直接回 null，这一层等于不存在。
 * 和 defaultClient 共用连接
 */
const scopedClient = 加上限定(defaultClient);

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

/** 企业版开了只读通道时每个模型的那一层：查、数走只读通道，别的（写）原样走主连接 */
const 分流的模型 = new Map<string, unknown>();

function 分流(prop: string, c: PrismaClient): unknown {
  if (prop === "$queryRaw" || prop === "$queryRawUnsafe") {
    return (...args: unknown[]) => {
      const sql = 取SQL(prop, args);
      const r = sql !== null && 只读SQL(sql) ? 读通道() : null;
      const 用 = (r ?? c) as unknown as Record<string, (...a: unknown[]) => unknown>;
      return 用[prop](...args);
    };
  }
  if (prop === "$transaction") {
    return (...args: unknown[]) => {
      // 数组式事务的每一句都得是主连接上建的；只读通道的查询混进来，Prisma 会把它放到事务外面跑——直接拦
      if (Array.isArray(args[0]) && args[0].some((p) => p && typeof p === "object" && 只读查询.has(p))) {
        throw new Error("数组式 $transaction 里不能放只读通道的查询：事务里的查询请用 tx 或交互式事务");
      }
      return (c.$transaction as (...a: unknown[]) => unknown).apply(c, args);
    };
  }
  if (prop === "$disconnect") return async () => { await 关读通道(); await c.$disconnect(); };
  const v = Reflect.get(c, prop, c);
  if (prop.startsWith("$") || prop.startsWith("_") || !v || typeof v !== "object") {
    return typeof v === "function" ? v.bind(c) : v;
  }
  if (!分流的模型.has(prop)) {
    分流的模型.set(prop, new Proxy(v as Record<string, unknown>, {
      get(d, m) {
        const f = Reflect.get(d, m, d);
        if (typeof f !== "function") return f;
        if (typeof m !== "string" || !读方法.has(m)) return f.bind(d);
        return (...args: unknown[]) => {
          // 每次现取：开关刚关掉就回主连接
          const r = 读通道() as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>> | null;
          return r ? r[prop][m](...args) : (f as (...a: unknown[]) => unknown).apply(d, args);
        };
      },
    }));
  }
  return 分流的模型.get(prop);
}

export const prisma: PrismaClient = new Proxy(defaultClient, {
  get(target, prop) {
    if (typeof prop !== "string") return Reflect.get(target, prop, target);

    // 自部署 / 桌面端：没有租户这一层；桌面端团队版的业务员限定、企业版按组织看客户在 scopedClient 里
    if (!multiTenant()) {
      const c = process.env.DESKTOP_LOCAL === "1" || 企业版() ? scopedClient : target;
      // 企业版的只读通道（lib/read-pool.ts）：查询分到另外 4 个连接，写入 / 事务照旧在这一个上。关着时下面一行不走
      if (c === scopedClient && 读通道开着()) return 分流(prop, c);
      const v = Reflect.get(c, prop, c);
      return typeof v === "function" ? v.bind(c) : v;
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
