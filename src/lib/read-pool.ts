import { PrismaClient } from "@/generated/prisma";
import { 加上限定 } from "./team-scope";
import { 企业版 } from "./enterprise/switch";

/**
 * 企业版的只读通道（2026-10-24）：查询另开 4 个连接，写入照旧走那 1 个。
 *
 * 为什么：库只开 1 个连接（lib/sqlite-url.ts，Linux 上多连接会让交互式事务卡死），30 人同时在线时
 * 所有查询在 Prisma 这一层排成一队。企业版 30 人 × 10 倍数据压测：1 个连接全站 p95 2042 ms、首页 3008 ms；
 * 4 个连接 438 ms / 631 ms，没有报错。
 *
 * 为什么这样不会再卡死：10-05 卡死的是「交互式事务开着时，别的连接上也在写」。这里写入、事务、裸 SQL 写
 * 一条都不进只读通道——还在那唯一的写连接上排队，和原来一模一样；只读通道上只有查询。
 * WAL 模式下读不拿写锁，也不等写锁，读到的是开查那一刻已提交的数据（和原来别的请求看到的一样）。
 *
 * 开关：只在企业版（CRM_ENTERPRISE=1）开；CRM_READ_POOL=0 一键关回单连接。桌面端、团队版、云端、托管版都不开。
 * 业务员 / 按组织看客户的限定照样套（加上限定），范围缓存是全局的，两个通道共用一份。
 *
 * 只读通道在代码层面拿不到 $transaction、$executeRaw 和任何写方法：类型上没有（只读客户端），运行时也拦（守门）。
 */

/** 只读通道的连接数（总控 10-24 定的先 4 个） */
export const 读连接数 = 4;

/** 能进只读通道的模型方法：只查、只数 */
export const 读方法 = new Set([
  "findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow",
  "count", "aggregate", "groupBy",
]);

type 读方法名 = "findMany" | "findFirst" | "findFirstOrThrow" | "findUnique" | "findUniqueOrThrow" | "count" | "aggregate" | "groupBy";
type 模型名 = { [K in keyof PrismaClient]: K extends `$${string}` | `_${string}` | symbol ? never : K }[keyof PrismaClient];

/** 只读通道的类型：每个模型只有查和数，顶层只有 $queryRaw 两个。没有 $transaction、$executeRaw */
export type 只读客户端 = { readonly [K in 模型名]: Pick<PrismaClient[K], Extract<keyof PrismaClient[K], 读方法名>> } & Pick<PrismaClient, "$queryRaw" | "$queryRawUnsafe">;

export class 只读通道错误 extends Error {
  constructor(what: string) {
    super(`只读通道不能做「${what}」：写入、事务一律走主连接`);
    this.name = "只读通道错误";
  }
}

/** 开着没：企业版、没写 CRM_READ_POOL=0、连的是本机 SQLite 文件。每次调用现读，改环境变量马上生效 */
export function 读通道开着(): boolean {
  if (!企业版() || process.env.CRM_READ_POOL === "0") return false;
  if (process.env.DESKTOP_LOCAL === "1" || process.env.MULTI_TENANT === "1") return false;
  return !!process.env.DATABASE_URL?.startsWith("file:");
}

const 写字眼 = /\b(insert|update|delete|replace|upsert|create|drop|alter|attach|detach|pragma|vacuum|reindex|analyze|returning|begin|commit|rollback|savepoint|release)\b/i;

/**
 * 一句裸 SQL 能不能进只读通道：只认 SELECT / WITH 开头、只有一句、没有任何会改东西的字眼。
 * 认不准的一律不进（回主连接，和原来一样），宁可少走一句也不能把写放进来
 */
export function 只读SQL(sql: string): boolean {
  const s = sql.trim();
  if (!/^(select|with)\b/i.test(s)) return false;
  if (s.includes(";") || s.includes("--") || s.includes("/*")) return false;
  return !写字眼.test(s);
}

/** $queryRaw 的模板 / Prisma.sql、$queryRawUnsafe 的字符串：取出 SQL 原文；认不出来回 null */
export function 取SQL(prop: string, args: unknown[]): string | null {
  const a = args[0];
  if (prop === "$queryRawUnsafe") return typeof a === "string" ? a : null;
  if (prop !== "$queryRaw" || !a || typeof a !== "object") return null;
  const strings = (a as { strings?: unknown }).strings ?? a;
  if (Array.isArray(strings) && strings.every((x) => typeof x === "string")) return strings.join("?");
  return null;
}

/** 只读通道发出去的查询，记下来：数组式 $transaction([...]) 里混进来要认得出（见 prisma.ts） */
export const 只读查询 = new WeakSet<object>();

const 记下 = <T,>(p: T): T => {
  if (p && typeof p === "object") 只读查询.add(p as object);
  return p;
};

/**
 * 给一个客户端套上守门：只放模型的查、数和只读裸 SQL，别的一律抛错。
 * 单独导出给测试用：守门拦得住才算数，不能只靠调用方自觉
 */
export function 守门(db: PrismaClient): 只读客户端 {
  const 模型 = new Map<string, unknown>();
  return new Proxy(db, {
    get(t, prop) {
      if (typeof prop !== "string") return Reflect.get(t, prop, t);
      if (prop === "$queryRaw" || prop === "$queryRawUnsafe") {
        return (...args: unknown[]) => {
          const sql = 取SQL(prop, args);
          if (sql === null || !只读SQL(sql)) throw new 只读通道错误(`${prop}：${(sql ?? "").slice(0, 60)}`);
          const fn = Reflect.get(t, prop, t) as (...a: unknown[]) => unknown;
          return 记下(fn.apply(t, args));
        };
      }
      if (prop === "then") return undefined;
      if (prop.startsWith("$") || prop.startsWith("_")) throw new 只读通道错误(prop);
      if (!模型.has(prop)) {
        const d = Reflect.get(t, prop, t) as Record<string, unknown> | undefined;
        if (!d || typeof d !== "object") throw new 只读通道错误(prop);
        模型.set(prop, new Proxy(d, {
          get(dt, m) {
            if (typeof m !== "string" || !读方法.has(m)) throw new 只读通道错误(`${prop}.${String(m)}`);
            const fn = Reflect.get(dt, m, dt) as (...a: unknown[]) => unknown;
            return (...args: unknown[]) => 记下(fn.apply(dt, args));
          },
        }));
      }
      return 模型.get(prop);
    },
  }) as unknown as 只读客户端;
}

const g = globalThis as unknown as { __读通道?: { 原: PrismaClient; 门: 只读客户端 } };

/** 连接串换成 4 个连接（原来写了 connection_limit 的也换：这条通道就是要多开） */
export function 读连接串(url: string): string {
  const 去掉 = url.replace(/([?&])connection_limit=\d+&?/, "$1").replace(/[?&]$/, "");
  return `${去掉}${去掉.includes("?") ? "&" : "?"}connection_limit=${读连接数}`;
}

/** 只读通道：用到才建（没开的部署一个连接都不多开）。关着回 null */
export function 读通道(): 只读客户端 | null {
  if (!读通道开着()) return null;
  if (!g.__读通道) {
    const 原 = new PrismaClient({
      datasourceUrl: 读连接串(process.env.DATABASE_URL!),
      log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    });
    g.__读通道 = { 原, 门: 守门(加上限定(原)) };
  }
  return g.__读通道.门;
}

/** 关掉只读通道的连接（$disconnect 时一起关；测试换开关时也用） */
export async function 关读通道(): Promise<void> {
  const x = g.__读通道;
  g.__读通道 = undefined;
  await x?.原.$disconnect();
}
