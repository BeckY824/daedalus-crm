/**
 * 跟进计划页分好的组记在共用的轻列表上（lib/plans-page.ts 取计划页 的 分好、lib/plans-groups.ts 分组日键，2026-10-25 企业版压测）。钉的是：
 * - 对拍：同一份轻列表跨过几个时刻（同一天里、北京零点前后、周日到周一、伦敦零点）、几个人轮着开，
 *   共用时摆出来的详情和老写法（每次两种看法现分一遍）挑出来的一样，整份和不共用的逐字一样
 * - 同一天同一个人再开不再分；换个人只分他「我的」那一份；北京零点一过整份重分
 * - 企业版人在伦敦：伦敦过零点不重分（业务日是北京的）；本机钟按本机零点
 * 不碰库：用一个按 where / select / include 现拼的假库，共用 用一个永不过期的 Map 代替 缓存着。
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const 计数 = vi.hoisted(() => ({ 分组: 0 }));
vi.mock("@/lib/plans-groups", async (原) => {
  const m = await 原<typeof import("@/lib/plans-groups")>();
  return { ...m, 分组: ((...a: Parameters<typeof m.分组>) => (计数.分组++, m.分组(...a))) as typeof m.分组 };
});

import { 取计划页, 取详情 } from "@/lib/plans-page";
import { 分组, 分组日键, 读每组, 组名 } from "@/lib/plans-groups";
import { scheduleValue } from "@/lib/schedule-date";

const 原环境 = { ...process.env };
afterEach(() => {
  vi.useRealTimers();
  for (const k of ["CRM_ENTERPRISE", "MULTI_TENANT", "TZ"]) {
    if (原环境[k] === undefined) delete process.env[k];
    else process.env[k] = 原环境[k];
  }
});

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

const 时 = 3_600_000;
// 2026-10-25 是周日：北京零点（UTC 16:00）一过既换天又换周；伦敦零点是 UTC 00:00
const 北京零点 = Date.parse("2026-10-25T16:00:00Z");
const 人们 = ["u0", "u1", "u2"];

type 计 = { id: string; plannedAt: Date; plannedOn: string | null; ownerId: string };
type 办 = { id: string; dueAt: Date | null; dueOn: string | null; ownerId: string };

/** 北京零点前后几天的计划和待办：每组都摆不下 50 条，有只有日期的、没定时间的、同一时刻一大片 */
function 造库(种子: number) {
  const r = 随机(种子);
  const 同一刻 = new Date(北京零点 - 3 * 时);
  const 日 = (d: Date) => new Date(d.getTime() + 8 * 时).toISOString().slice(0, 10);
  const 计划: 计[] = Array.from({ length: 600 }, (_, i) => {
    const d = r() < 0.15 ? 同一刻 : new Date(北京零点 + Math.floor((r() - 0.4) * 12 * 24 * 60) * 60_000);
    return { id: `p${i}`, plannedAt: d, plannedOn: r() < 0.3 ? 日(d) : null, ownerId: 人们[Math.floor(r() * 3)] };
  });
  const 待办: 办[] = Array.from({ length: 200 }, (_, i) => {
    const d = new Date(北京零点 + Math.floor((r() - 0.4) * 12 * 24 * 60) * 60_000);
    const 空 = r() < 0.15;
    return { id: `t${i}`, dueAt: 空 ? null : d, dueOn: !空 && r() < 0.3 ? 日(d) : null, ownerId: 人们[Math.floor(r() * 3)] };
  });
  /** 老写法：和改之前 取计划页 一样，每次把全部成员、我的各分一遍，挑每组前 N 条 */
  const 老写法要 = (me: string, 每组: readonly number[]) => {
    const 全部 = [
      ...[...计划].sort((a, b) => a.plannedAt.getTime() - b.plannedAt.getTime() || (a.id < b.id ? -1 : 1)).map((p) => ({ key: `plan:${p.id}`, 时间: scheduleValue(p.plannedAt, p.plannedOn), ownerId: p.ownerId })),
      ...[...待办].sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) || (a.id < b.id ? -1 : 1)).map((t) => ({ key: `task:${t.id}`, 时间: scheduleValue(t.dueAt, t.dueOn), ownerId: t.ownerId })),
    ];
    const 要 = new Set<string>();
    for (const 这些 of [全部, 全部.filter((x) => x.ownerId === me)]) {
      const 组 = 分组(这些);
      组名.forEach((g, i) => { for (const x of 组[g].slice(0, 每组[i])) 要.add(x.key); });
    }
    return [...要];
  };
  const 序 = (a: { t: number; id: string }, b: { t: number; id: string }) => a.t - b.t || (a.id < b.id ? -1 : 1);
  const 表 = <R extends { id: string; ownerId: string }>(行: R[], 时间: (x: R) => number, 详: (x: R) => object) => ({
    findMany: async (a: { where?: { id?: { in: string[] } }; select?: object }) => {
      const 只要 = a.where?.id?.in ? new Set(a.where.id.in) : null;
      return 行
        .filter((x) => !只要 || 只要.has(x.id))
        .map((x) => ({ x, t: 时间(x), id: x.id }))
        .sort(序)
        .map(({ x }) => (a.select ? { ...x } : { ...x, ...详(x), owner: { id: x.ownerId, name: x.ownerId }, updatedAt: new Date(0) }));
    },
  });
  const db = {
    followPlan: 表(计划, (x) => x.plannedAt.getTime(), (x) => ({ subject: x.id, plannedHasTime: true, method: "电话", customer: { id: "c", name: "客户", extra: null } })),
    task: 表(待办, (x) => x.dueAt?.getTime() ?? Infinity, (x) => ({ title: x.id, dueHasTime: true, customer: { id: "c", name: "客户" } })),
  } as unknown as Parameters<typeof 取计划页>[0];
  return { db, 老写法要 };
}

/** 永不过期的 共用：一份轻列表跨过所有时刻（比 30 秒的 缓存着 更狠） */
function 永久共用() {
  const 存 = new Map<string, Promise<unknown>>();
  return <T,>(key: string, 算: () => Promise<T>) => {
    if (!存.has(key)) 存.set(key, 算());
    return 存.get(key) as Promise<T>;
  };
}

const 每组 = 读每组(undefined);
const 默认每组 = 每组;
const 看多了 = 读每组("100,50,150,200");
const 开企业版 = () => { process.env.CRM_ENTERPRISE = "1"; delete process.env.MULTI_TENANT; };

describe("取计划页：分好的组记在共用的轻列表上", () => {
  for (const 钟 of ["北京业务钟", "本机"] as const) {
    it(`对拍（${钟}）：跨过几个时刻、几个人轮着开，共用和每次现分逐字一样`, async () => {
      if (钟 === "北京业务钟") 开企业版();
      else { delete process.env.CRM_ENTERPRISE; delete process.env.MULTI_TENANT; }
      vi.useFakeTimers({ toFake: ["Date"] });
      for (let 种子 = 1; 种子 <= 4; 种子++) {
        const { db, 老写法要 } = 造库(种子);
        const 共用 = 永久共用();
        const r = 随机(种子 * 7);
        const 时刻们 = [-9 * 时, -1, 0, 1, 2 * 时, 8 * 时 - 1, 8 * 时, 30 * 时].map((d) => 北京零点 + d);
        for (const t of 时刻们) {
          vi.setSystemTime(t);
          // 先默认每组 50、再「再看 50 条」加大：共用的组只读，前一次挑少了不影响后一次
          for (const [me, 每组] of [...人们, 人们[Math.floor(r() * 3)], "没这个人"].flatMap((me) => [[me, 默认每组], [me, 看多了]] as const)) {
            const 共用的 = await 取计划页(db, 每组, me, 共用);
            const 现分的 = await 取计划页(db, 每组, me);
            const 哪次 = `${钟} 种子 ${种子} ${new Date(t).toISOString()} ${me}`;
            const 老 = 老写法要(me, 每组);
            if (me !== "没这个人") expect(老.length, 哪次).toBeGreaterThan(150); // 每组都摆不下、我的和全部成员挑出来的不一样
            const { plans, tasks } = await 取详情(db, 老);
            expect({ plans: 共用的.plans, tasks: 共用的.tasks }, 哪次).toEqual({ plans, tasks });
            expect(共用的, 哪次).toEqual(现分的);
          }
        }
      }
    });
  }

  it("同一天同一个人再开不再分；换个人只分他那份；北京零点一过整份重分；伦敦零点不重分", async () => {
    开企业版();
    process.env.TZ = "Europe/London";
    vi.useFakeTimers({ toFake: ["Date"] });
    const { db } = 造库(9);
    const 共用 = 永久共用();
    const 分了几次 = async (me: string) => {
      const 前 = 计数.分组;
      await 取计划页(db, 每组, me, 共用);
      return 计数.分组 - 前;
    };
    vi.setSystemTime(北京零点 - 5 * 时);
    expect(await 分了几次("u0")).toBe(2); // 全部成员 + u0 的
    expect(await 分了几次("u0")).toBe(0);
    expect(await 分了几次("u1")).toBe(1); // 全部成员那份共用
    vi.setSystemTime(北京零点 - 1);
    expect(await 分了几次("u0")).toBe(0);
    vi.setSystemTime(北京零点);
    expect(await 分了几次("u0")).toBe(2);
    expect(await 分了几次("u1")).toBe(1);
    // 北京早上 8 点 = 伦敦零点：业务日没变
    vi.setSystemTime(北京零点 + 8 * 时 - 1);
    expect(await 分了几次("u0")).toBe(0);
    vi.setSystemTime(北京零点 + 8 * 时);
    expect(await 分了几次("u0")).toBe(0);
    // 不共用（限定可见范围的人）：照旧每次分两遍
    const 前 = 计数.分组;
    await 取计划页(db, 每组, "u0");
    await 取计划页(db, 每组, "u0");
    expect(计数.分组 - 前).toBe(4);
  });
});

describe("分组日键", () => {
  it("北京业务钟：北京一天之内同一个键，过北京零点换；伦敦零点不换", () => {
    开企业版();
    process.env.TZ = "Europe/London";
    vi.useFakeTimers({ toFake: ["Date"] });
    const 键 = (t: number) => (vi.setSystemTime(t), 分组日键());
    expect(键(北京零点 - 24 * 时)).toBe(键(北京零点 - 1));
    expect(键(北京零点)).not.toBe(键(北京零点 - 1));
    expect(键(北京零点 + 8 * 时 - 1)).toBe(键(北京零点 + 8 * 时));
    expect(键(北京零点 + 24 * 时 - 1)).toBe(键(北京零点));
  });

  it("本机钟：按本机零点换", () => {
    delete process.env.CRM_ENTERPRISE;
    delete process.env.MULTI_TENANT;
    process.env.TZ = "Europe/London";
    vi.useFakeTimers({ toFake: ["Date"] });
    const 键 = (t: number) => (vi.setSystemTime(t), 分组日键());
    const 伦敦零点 = Date.parse("2026-10-26T00:00:00Z");
    expect(键(伦敦零点 - 1)).not.toBe(键(伦敦零点));
    expect(键(北京零点 - 1)).toBe(键(北京零点));
  });
});
