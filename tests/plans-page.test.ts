/**
 * 跟进计划页分批取（lib/plans-page.ts、lib/plans-groups.ts，2026-10-24 企业版压测）和原来「全取回来画」对拍：
 *
 *   - 轻列表：条数、key、时间、负责人和原来全取的一模一样，组头条数和「我的 / 全部成员」都在它上面算
 *   - 每组前 N 条（「我的」和「全部成员」两种看法）的详情都在，和原来那一条的详情一模一样
 *   - 「再看 50 条」一直点到底：每组摆出来的正好是全部、顺序和原来分组排完的一样
 *   - 每组不到 50 条（个人版）：不带轻列表，plans / tasks 和原来全取的完全一样（顺序也一样）
 *   - 随机数据：同一时刻一大片、只有日期的（plannedOn / dueOn）、没定时间的待办、今天 / 本周边界、
 *     id 有大写 / 连字符 / 下划线
 *   - 补计划详情：只认 plan: / task: 开头的 key、最多 500 条、做完的不给
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { scheduleValue } from "@/lib/schedule-date";
import { dayjs } from "@/lib/utils";
import type { Dayjs } from "dayjs";
import { 取计划页, 取详情, type 计划页 } from "@/lib/plans-page";
import { 每批, 组名, 读每组, 写每组, 分组 } from "@/lib/plans-groups";

const 登录的 = vi.hoisted(() => ({ 有: true }));
vi.mock("@/lib/auth", async (原) => ({
  ...(await 原<object>()),
  requireUser: async () => {
    if (!登录的.有) throw new Error("未登录");
    return { id: "u", name: "u", role: "ADMIN" };
  },
}));

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

/** 一条要排在哪一组：灌数据时按它挑时间 */
function 时间在(组: (typeof 组名)[number], r: () => number, 同一刻: Date): { at: Date | null; on: string | null } {
  const now = dayjs();
  const 只要日期 = r() < 0.2;
  const 同刻 = r() < 0.3;
  let d: Dayjs;
  if (组 === "逾期") d = now.subtract(1 + Math.floor(r() * 40), "day");
  else if (组 === "今天") d = now.startOf("day").add(Math.floor(r() * 23 * 60), "minute");
  else if (组 === "本周") {
    // 本周还剩的日子；今天就是周日时没有，落到以后
    const 剩 = now.endOf("week").diff(now.endOf("day"), "day");
    d = 剩 > 0 ? now.endOf("day").add(1 + Math.floor(r() * 剩), "hour") : now.add(10, "day");
  } else d = now.add(8 + Math.floor(r() * 60), "day");
  if (同刻 && 组 !== "以后") d = dayjs(同一刻);
  if (只要日期) return { at: d.startOf("day").toDate(), on: d.format("YYYY-MM-DD") };
  return { at: d.toDate(), on: null };
}

/** 每组灌几条计划 / 待办：有 0、不到一批、正好一批、多一条、好几批 */
async function 灌(种子: number, 每组计划: number[], 每组待办: number[]) {
  const r = 随机(种子);
  const 人 = await Promise.all(
    ["甲", "乙", "丙"].map((n, i) => prisma.user.create({ data: { email: `plan${种子}-${i}`, name: n, role: "SALES", password: "x" } })),
  );
  const 客户 = Array.from({ length: 12 }, (_, i) => ({ id: `pc${种子}-${i}`, name: `客户${i}`, phone: `136${种子}${i}`, salesOwnerId: 人[0].id }));
  await prisma.customer.createMany({ data: 客户 });
  await prisma.customerExtra.createMany({ data: 客户.filter((_, i) => i % 3 === 0).map((c, i) => ({ customerId: c.id, whatsapp: i % 2 ? " " : "+8613800000000" })) });
  const 编号 = (前: string, i: number) => [`${前}${种子}-${i}`, `${前.toUpperCase()}${种子}x${i}`, `${前}${种子}_${i}`, `c${前}${种子}${i}`][i % 4];
  // 每组一个「同一时刻」：一大片排在同一刻，翻页要靠 id 定先后
  const 同一刻 = { 逾期: dayjs().subtract(3, "day").toDate(), 今天: dayjs().startOf("day").add(1, "minute").toDate(), 本周: dayjs().endOf("week").subtract(2, "hour").toDate(), 以后: new Date() };
  const 谁 = () => 人[r() < 0.5 ? 0 : 1 + Math.floor(r() * 2)].id;
  let i = 0;
  for (const [k, g] of 组名.entries()) {
    for (let j = 0; j < 每组计划[k]; j++) {
      const t = 时间在(g, r, 同一刻[g]);
      await prisma.followPlan.create({
        data: {
          id: 编号("p", i++), subject: `计划${i}`, plannedAt: t.at ?? new Date(), plannedOn: t.on, plannedHasTime: t.on ? false : r() < 0.5 ? true : null,
          method: ["电话沟通", "WhatsApp", "上门拜访"][Math.floor(r() * 3)], customerId: 客户[Math.floor(r() * 客户.length)].id, ownerId: 谁(),
        },
      });
    }
    for (let j = 0; j < 每组待办[k]; j++) {
      // 以后那组一半是没定时间的
      const t = g === "以后" && r() < 0.5 ? { at: null, on: null } : 时间在(g, r, 同一刻[g]);
      await prisma.task.create({
        data: {
          id: 编号("t", i++), title: `待办${i}`, dueAt: t.at, dueOn: t.on, dueHasTime: t.at && !t.on ? true : null,
          customerId: 客户[Math.floor(r() * 客户.length)].id, ownerId: 谁(),
        },
      });
    }
  }
  // 做完的不该出现
  await prisma.followPlan.create({ data: { id: `pdone${种子}`, subject: "做完的", plannedAt: new Date(), done: true, doneAt: new Date(), customerId: 客户[0].id, ownerId: 人[0].id } });
  await prisma.task.create({ data: { id: `tdone${种子}`, title: "做完的", done: true, doneAt: new Date(), customerId: 客户[0].id, ownerId: 人[0].id } });
  return 人[0].id;
}

/**
 * 原来 page.tsx 那一段：全取回来、映射成行。
 * 加 id：同一时刻的先后原来由库决定（没有定义），分批要定下来；除此之外和原来一字不差
 */
async function 原来全取(加id = false): Promise<计划页> {
  const [plans, tasks] = await Promise.all([
    prisma.followPlan.findMany({
      where: { done: false },
      orderBy: 加id ? [{ plannedAt: "asc" }, { id: "asc" }] : { plannedAt: "asc" },
      include: { customer: { select: { id: true, name: true, extra: { select: { whatsapp: true } } } }, owner: { select: { id: true, name: true } } },
    }),
    prisma.task.findMany({
      where: { done: false },
      orderBy: 加id ? [{ dueAt: { sort: "asc", nulls: "last" } }, { id: "asc" }] : { dueAt: { sort: "asc", nulls: "last" } },
      include: { customer: { select: { id: true, name: true } }, owner: { select: { id: true, name: true } } },
    }),
  ]);
  return {
    plans: plans.map((p) => ({
      id: p.id, subject: p.subject, plannedAt: scheduleValue(p.plannedAt, p.plannedOn)!, plannedHasTime: p.plannedHasTime, method: p.method,
      updatedAt: p.updatedAt.toISOString(), customerId: p.customer.id, customerName: p.customer.name, 有WhatsApp: !!p.customer.extra?.whatsapp?.trim(),
      ownerId: p.owner.id, ownerName: p.owner.name,
    })),
    tasks: tasks.map((t) => ({
      id: t.id, title: t.title, dueAt: scheduleValue(t.dueAt, t.dueOn), dueHasTime: t.dueHasTime, updatedAt: t.updatedAt.toISOString(),
      customerId: t.customer.id, customerName: t.customer.name, ownerId: t.owner.id, ownerName: t.owner.name,
    })),
  };
}

type 行 = { key: string; 时间: string | null; ownerId: string };
const 成行 = (页: Pick<计划页, "plans" | "tasks">): 行[] => [
  ...页.plans.map((p) => ({ key: `plan:${p.id}`, 时间: p.plannedAt, ownerId: p.ownerId })),
  ...页.tasks.map((t) => ({ key: `task:${t.id}`, 时间: t.dueAt, ownerId: t.ownerId })),
];
const 详情表 = (页: Pick<计划页, "plans" | "tasks">) =>
  new Map<string, unknown>([...页.plans.map((p) => [`plan:${p.id}`, p] as const), ...页.tasks.map((t) => [`task:${t.id}`, t] as const)]);

/** 页面上（PlansView）这一种看法每组摆哪几条、组头写几条：照它的做法在轻列表上分组、切前 N 条 */
function 页面摆(页: 计划页, 每组: number[] | undefined, 我: string | null) {
  const 全部: 行[] = 页.轻 ? 页.轻.map(([key, 时间, i]) => ({ key, 时间, ownerId: 页.负责人![i] })) : 成行(页);
  const 组 = 分组(我 ? 全部.filter((x) => x.ownerId === 我) : 全部);
  return Object.fromEntries(组名.map((g, i) => [g, { 共: 组[g].length, 摆: 组[g].slice(0, 页.轻 ? 每组?.[i] ?? 每批 : Infinity).map((x) => x.key) }]));
}

describe("跟进计划分批取", () => {
  for (const 种子 of [1, 7, 42]) {
    it(`组头条数 = 全部、前 N 条详情齐全且和原来一样、翻到底和原来一样（种子 ${种子}）`, async () => {
      const 我 = await 灌(种子, [130, 49, 51, 3], [20, 1, 50, 140]);
      const 原 = await 原来全取(true);
      const 原详 = 详情表(原);
      const 原摆 = { 我的: 页面摆(原, undefined, 我), 全部成员: 页面摆(原, undefined, null) };

      let 每组 = 读每组(undefined);
      for (let 轮 = 0; ; 轮++) {
        expect(轮).toBeLessThan(10);
        const 页 = await 取计划页(prisma, 每组, 我);
        const 详 = 详情表(页);
        if (页.轻) {
          // 轻列表就是全部：key、时间、负责人和原来一样，一条不多一条不少
          expect(页.轻.map(([key, 时间, i]) => ({ key, 时间, ownerId: 页.负责人![i] }))).toEqual(成行(原));
        } else {
          // 翻到底了：和原来全取的一模一样（同一时刻按 id，和前几页一致）
          expect(页).toEqual(原);
        }
        // 带回来的每一条详情都和原来那条一样
        for (const [k, v] of 详) expect(v).toEqual(原详.get(k));
        let 还有 = false;
        for (const [看法, 我的] of [["我的", 我], ["全部成员", null]] as const) {
          const 摆 = 页面摆(页, 每组, 我的);
          for (const g of 组名) {
            // 组头条数是这一组的全部
            expect(摆[g].共).toBe(原摆[看法][g].共);
            // 摆出来的是原来这一组的前 N 条，顺序一样，详情都在手里（不用页面再去补）
            expect(摆[g].摆).toEqual(原摆[看法][g].摆.slice(0, 摆[g].摆.length));
            for (const k of 摆[g].摆) expect(详.has(k)).toBe(true);
            if (摆[g].摆.length < 摆[g].共) 还有 = true;
          }
        }
        if (!页.轻) {
          expect(还有).toBe(false);
          break;
        }
        // 点「再看 50 条」：每组各加一批（URL 往返一次）
        每组 = 读每组(写每组(每组.map((n) => n + 每批)));
      }
    });
  }

  it("每组都不到 50 条（个人版）：不带轻列表，和原来全取的完全一样", async () => {
    // 计划和待办同组；今天是周日时「本周」那几条落进「以后」，也不到 50
    const 我 = await 灌(3, [10, 30, 2, 0], [0, 5, 15, 15]);
    // 记下发给库的参数：全取时是原来那两句（orderBy 不加 id）
    const 发: { 表: string; orderBy: unknown }[] = [];
    const 记 = (表: "followPlan" | "task") => ({ findMany: (a: { orderBy: unknown }) => (发.push({ 表, orderBy: a.orderBy }), (prisma[表].findMany as (x: unknown) => unknown)(a)) });
    const 页 = await 取计划页({ followPlan: 记("followPlan"), task: 记("task") } as unknown as Parameters<typeof 取计划页>[0], 读每组(undefined), 我);
    expect(页.轻).toBeUndefined();
    expect(页.负责人).toBeUndefined();
    expect(页).toEqual(await 原来全取());
    expect(发.slice(-2)).toEqual([
      { 表: "followPlan", orderBy: { plannedAt: "asc" } },
      { 表: "task", orderBy: { dueAt: { sort: "asc", nulls: "last" } } },
    ]);
  });

  it("空库：什么都没有", async () => {
    expect(await 取计划页(prisma, 读每组(undefined), "x")).toEqual({ plans: [], tasks: [] });
  });

  it("只有一组超过 50 条：其他组照样全摆，详情只取要摆的", async () => {
    const 我 = await 灌(5, [200, 3, 0, 0], [0, 0, 0, 0]);
    const 页 = await 取计划页(prisma, 读每组(undefined), 我);
    expect(页.轻).toHaveLength(203);
    // 「我的」前 50 + 「全部成员」前 50，重叠的只取一次；今天那 3 条都在
    expect(页.plans.length).toBeLessThanOrEqual(103);
    expect(页.plans.length).toBeGreaterThanOrEqual(53);
  });

  it("n= 读写：缺的、乱写的、小于一批的都按一批", () => {
    expect(读每组(undefined)).toEqual([50, 50, 50, 50]);
    expect(读每组("100,abc,-5,1e3")).toEqual([100, 50, 50, 1000]);
    expect(读每组("49,51")).toEqual([50, 51, 50, 50]);
    expect(读每组("50.5,9007199254740993,,")).toEqual([50, 50, 50, 50]);
    expect(写每组([100, 50, 150, 50])).toBe("100,50,150,50");
    expect(读每组(写每组([100, 50, 150, 50]))).toEqual([100, 50, 150, 50]);
  });

  it("分组：只有日期的按日历日、没时间的在以后、同一刻按传进来的先后", () => {
    const now = dayjs("2026-10-21T10:00:00"); // 周三
    const 行 = [
      { key: "a", 时间: "2026-10-20" },
      { key: "b", 时间: "2026-10-21" },
      { key: "c", 时间: null },
      { key: "d", 时间: "2026-10-21T09:00:00.000Z" },
      { key: "e", 时间: "2026-10-21T09:00:00.000Z" },
      { key: "f", 时间: "2026-10-25T12:00:00" },
      { key: "g", 时间: "2026-10-26T00:00:00" },
    ];
    const g = 分组(行, now);
    expect(g.逾期.map((x) => x.key)).toEqual(["a"]);
    expect(g.今天.map((x) => x.key)).toEqual(["b", "d", "e"]);
    expect(g.本周.map((x) => x.key)).toEqual(["f"]);
    expect(g.以后.map((x) => x.key)).toEqual(["g", "c"]);
  });
});

describe("补计划详情", () => {
  it("只给还没做完的；key 不对、太多、没登录都不给", async () => {
    const { 补计划详情 } = await import("@/app/(app)/follow-ups/plans/plan-rows");
    await 灌(9, [3, 0, 0, 0], [0, 0, 0, 2]);
    const 原 = await 原来全取();
    const keys = 成行(原).map((x) => x.key);
    const r = await 补计划详情([...keys, "plan:pdone9", "task:tdone9", "plan:nope"]);
    expect(r).toEqual(await 取详情(prisma, keys));
    expect(r.plans).toHaveLength(3);
    expect(r.tasks).toHaveLength(2);
    expect(await 补计划详情(["customer:x"])).toEqual({ plans: [], tasks: [] });
    expect(await 补计划详情(["plan:a b"])).toEqual({ plans: [], tasks: [] });
    // 最多 500 个：真 key 凑满 500 照给，501 个一条都不给
    const 凑 = (n: number) => [...keys, ...Array.from({ length: n - keys.length }, (_, i) => `plan:x${i}`)];
    expect(await 补计划详情(凑(500))).toEqual(r);
    expect(await 补计划详情(凑(501))).toEqual({ plans: [], tasks: [] });
    expect(await 补计划详情("plan:x" as unknown as string[])).toEqual({ plans: [], tasks: [] });
    expect(await 补计划详情([])).toEqual({ plans: [], tasks: [] });
    登录的.有 = false;
    try {
      await expect(补计划详情(keys)).rejects.toThrow();
    } finally {
      登录的.有 = true;
    }
  });
});
