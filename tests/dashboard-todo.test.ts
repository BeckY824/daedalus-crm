/**
 * 首页「近期跟进任务」先只取时间排出前几名、再取这几条的标题和客户（lib/dashboard-todo.ts，2026-10-24 企业版压测），
 * 和原来「两张表全取回来排」（全取待办，就是 Board 原来那一段）对拍：条目、顺序必须完全一样。
 *
 *   - 随机数据：任务有没排时间的、只排日期的（dueOn）、排了钟点的；计划有只排日期的；一部分已完成
 *   - 同一时刻一大片（只排日期的同一天、钟点相同的）：靠 id 定先后；id 有大写、连字符
 *   - 时区：Asia/Shanghai、Europe/London、America/New_York（只排日期的按本地零点排）
 *   - 取 0 / 1 / 5 / 20 / 全部 条
 *   - 两步之间有一条被完成、被删、改了时间：退回全取，结果和那一刻全取的一样
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 近期待办, 全取待办 } from "@/lib/dashboard-todo";

const 原TZ = process.env.TZ;
afterAll(() => {
  process.env.TZ = 原TZ;
});
beforeEach(resetDb);

function 随机(种子: number) {
  let s = 种子 >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const 天 = 86_400_000;
const 起 = Date.parse("2026-10-20T00:00:00Z");

async function 灌(种子: number) {
  const r = 随机(种子);
  const 人 = (await prisma.user.create({ data: { email: `todo${种子}`, name: "销售", role: "SALES", password: "x" } })).id;
  const 客户 = Array.from({ length: 30 }, (_, i) => ({ id: `td${种子}c${i}`, name: `客户${i}`, phone: `136${种子}${i}`, salesOwnerId: 人 }));
  await prisma.customer.createMany({ data: 客户 });
  // 时刻挤在几天里，同一刻的多：排序得靠 id
  const 时刻 = () => new Date(起 + Math.floor(r() * 6) * 天 + [0, 0, 9 * 3600_000, 16 * 3600_000, Math.floor(r() * 天)][Math.floor(r() * 5)]);
  const 日期 = () => `2026-10-${String(19 + Math.floor(r() * 6)).padStart(2, "0")}`;
  const 编号 = (前: string, i: number) => [`${前}${种子}-${i}`, `${前.toUpperCase()}${种子}x${i}`, `${前}${种子}_${i}`, `c${前}${种子}${i}`][i % 4];
  await prisma.task.createMany({
    data: Array.from({ length: 120 }, (_, i) => {
      const 型 = r();
      const at = 型 < 0.15 ? null : 时刻();
      return {
        id: 编号("t", i),
        title: `任务${i}`,
        customerId: 客户[Math.floor(r() * 客户.length)].id,
        ownerId: 人,
        dueAt: at,
        // 三成只排日期；有一点是不合法的日期串（scheduleValue 退回 dueAt）
        dueOn: at && 型 < 0.45 ? (r() < 0.1 ? "下周" : 日期()) : null,
        done: r() < 0.25,
      };
    }),
  });
  await prisma.followPlan.createMany({
    data: Array.from({ length: 120 }, (_, i) => ({
      id: 编号("p", i),
      subject: `计划${i}`,
      customerId: 客户[Math.floor(r() * 客户.length)].id,
      ownerId: 人,
      plannedAt: 时刻(),
      plannedOn: r() < 0.35 ? 日期() : null,
      done: r() < 0.25,
    })),
  });
}

describe("首页待办：先排时间再取详情，和全取回来排一模一样", () => {
  for (const tz of ["Asia/Shanghai", "Europe/London", "America/New_York"]) {
    it(tz, async () => {
      process.env.TZ = tz;
      expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(tz);
      for (const 种子 of [1, 2, 3]) {
        await resetDb();
        await 灌(种子);
        // 有同一刻的才算测到 id 定先后
        const 全 = await 全取待办(prisma, Infinity);
        const 时刻们 = 全.map((x) => x.dueAt);
        expect(new Set(时刻们).size, `有同一刻的 · 种子 ${种子}`).toBeLessThan(时刻们.length);
        expect(全.some((x) => x.dueAt === null), "有没排时间的").toBe(true);
        for (const n of [0, 1, 5, 20, 1000]) {
          expect(await 近期待办(prisma, n), `${tz} · 种子 ${种子} · 取 ${n} 条`).toEqual(await 全取待办(prisma, n));
        }
        expect(await 近期待办(prisma)).toEqual(全.slice(0, 5));
      }
    }, 60_000);
  }

  it("空库", async () => {
    expect(await 近期待办(prisma)).toEqual([]);
  });

  /** 第二步（按 id 取详情）之前先动一下库：模拟两步之间别人刚改了 */
  function 两步之间(动: (ids: string[], 表: "task" | "followPlan") => Promise<void>) {
    let 动过 = false;
    const 包表 = (表: "task" | "followPlan") =>
      new Proxy(prisma[表], {
        get(t, p, r) {
          if (p !== "findMany") return Reflect.get(t, p, r);
          return async (arg: { where?: { id?: { in?: string[] } } }) => {
            const ids = arg?.where?.id?.in;
            if (ids && !动过) {
              动过 = true;
              await 动(ids, 表);
            }
            return (t.findMany as (a: unknown) => Promise<unknown>)(arg);
          };
        },
      });
    return { task: 包表("task"), followPlan: 包表("followPlan") } as unknown as Pick<typeof prisma, "task" | "followPlan">;
  }

  for (const [名, 动] of [
    ["被完成", (id: string, 表: "task" | "followPlan") => (表 === "task" ? prisma.task.update({ where: { id }, data: { done: true } }) : prisma.followPlan.update({ where: { id }, data: { done: true } }))],
    ["被删", (id: string, 表: "task" | "followPlan") => (表 === "task" ? prisma.task.delete({ where: { id } }) : prisma.followPlan.delete({ where: { id } }))],
    ["改了时间", (id: string, 表: "task" | "followPlan") => (表 === "task" ? prisma.task.update({ where: { id }, data: { dueAt: new Date(起 + 40 * 天), dueOn: null } }) : prisma.followPlan.update({ where: { id }, data: { plannedAt: new Date(起 + 40 * 天), plannedOn: null } }))],
  ] as const) {
    it(`两步之间有一条${名}：退回全取`, async () => {
      process.env.TZ = "Asia/Shanghai";
      await 灌(7);
      const 前 = await 全取待办(prisma);
      const db = 两步之间(async (ids, 表) => {
        await 动(ids[0], 表);
      });
      const 新 = await 近期待办(db);
      const 后 = await 全取待办(prisma);
      expect(后, "库真的变了").not.toEqual(前);
      expect(新).toEqual(后);
    });
  }
});
