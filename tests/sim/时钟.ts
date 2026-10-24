/**
 * 一周模拟的时钟：假时间 + 让 Prisma 也用假时间。
 *
 * vi.setSystemTime 只管 JS 的 Date。schema 里的 @default(now()) 和 @updatedAt 是
 * 查询引擎（Rust）自己取的真时间，不跟假时钟走——不补的话「三天前建的线索」
 * createdAt 还是今天，超时回收永远算不出来。
 *
 * 做法：给 Prisma 客户端包一层查询扩展，建记录时把 now() 字段补成 new Date()（假时间），
 * 改记录时补 updatedAt。字段表从 Prisma.dmmf 读，schema 加字段不用改这里。
 * 局限：嵌套 create 和原生 SQL 不补；模拟脚本只用顶层 create。
 *
 * 用法（vi.mock 必须写在测试文件顶层，vitest 会提升它）：
 *   vi.mock("@/generated/prisma", async (orig) => (await import("./sim/时钟")).补时间的生成客户端(await orig()));
 */
import { vi } from "vitest";

type 字段表 = Map<string, { 建: string[]; 改: string[] }>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function 读字段表(Prisma: any): 字段表 {
  const m: 字段表 = new Map();
  for (const model of Prisma.dmmf.datamodel.models) {
    const 建: string[] = [];
    const 改: string[] = [];
    for (const f of model.fields) {
      const d = f.default as { name?: string } | undefined;
      if (d && typeof d === "object" && d.name === "now") 建.push(f.name);
      if (f.isUpdatedAt) { 建.push(f.name); 改.push(f.name); }
    }
    if (建.length || 改.length) {
      // query 扩展里 model 名是 PascalCase
      m.set(model.name, { 建, 改 });
    }
  }
  return m;
}

function 补(data: unknown, 字段: string[], 只补没有的: boolean) {
  if (!data || typeof data !== "object") return;
  const d = data as Record<string, unknown>;
  const 今 = new Date();
  for (const k of 字段) {
    if (只补没有的 && d[k] !== undefined) continue;
    d[k] = 今;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function 包(client: any, 表: 字段表) {
  return client.$extends({
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations({ model, operation, args, query }: any) {
          const f = 表.get(model);
          if (f) {
            if (operation === "create") 补(args.data, f.建, true);
            else if (operation === "createMany" || operation === "createManyAndReturn") {
              for (const row of Array.isArray(args.data) ? args.data : [args.data]) 补(row, f.建, true);
            } else if (operation === "upsert") {
              补(args.create, f.建, true);
              补(args.update, f.改, true);
            } else if (operation === "update" || operation === "updateMany" || operation === "updateManyAndReturn") {
              补(args.data, f.改, true);
            }
          }
          return query(args);
        },
      },
    },
  });
}

/**
 * 换掉 "@/generated/prisma" 的 PrismaClient：new 出来的就是补过时间的客户端。
 * 放在最底层，lib/prisma.ts 在它上面再包的团队版 / 企业版范围（加上限定）照常生效。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function 补时间的生成客户端(m: any) {
  const 原 = m.PrismaClient;
  const 表 = 读字段表(m.Prisma);
  // lib/prisma.ts 在 globalThis 上缓存客户端；同一进程里前一个测试文件留下的是没补过的，丢掉
  (globalThis as { prisma?: unknown }).prisma = undefined;
  function PrismaClient(...a: unknown[]) {
    return 包(new 原(...a), 表);
  }
  PrismaClient.prototype = 原.prototype;
  return { ...m, PrismaClient };
}

/** 把假时钟拨到某个时刻（北京时间写法，例 "2026-01-30 09:00" 或 "2026-01-28 23:59:59"） */
export function 拨到(北京时间: string) {
  const 秒 = 北京时间.length > 16 ? "" : ":00";
  const d = new Date(北京时间.replace(" ", "T") + 秒 + "+08:00");
  vi.setSystemTime(d);
  return d;
}

export function 开始假时间(北京时间: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  return 拨到(北京时间);
}

export function 停掉假时间() {
  vi.useRealTimers();
}
