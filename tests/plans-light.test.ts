/**
 * 跟进计划页轻列表的紧凑写法（lib/plans-light.ts）和原来的轻列表对拍：
 *   - 压了再解，和直接展开轻列表一字不差：ISO 时间（毫秒、秒、分钟精度，1970 年前、很远的将来）、只有日期的、
 *     没时间的、写法不标准的时间串、乱序、同一时刻、各种 id，过一遍 JSON 也一样
 *   - key 里有逗号、前缀不认识：不压（返回 null），页面照原来拿轻列表
 *   - 企业版那种 1.5 万条：压完不到原来的 55%
 *   - 整页（page.tsx）：分批时给 紧 不给 轻，解出来就是 取计划页 的轻列表；个人版两样都不给；压不了照原样给 轻
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { 压轻, 解轻 } from "@/lib/plans-light";
import type { 轻行 } from "@/lib/plans-page";

const state = vi.hoisted(() => ({ user: { id: "", name: "QA", email: "qa", role: "ADMIN", title: "管理员" } }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => state.user }));
vi.mock("@/app/(app)/follow-ups/plans/PlansView", () => ({ default: () => null }));
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import PlansPage from "@/app/(app)/follow-ups/plans/page";
import { 取计划页 } from "@/lib/plans-page";
import { 读每组 } from "@/lib/plans-groups";

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

/** 原来 PlansView 拿轻列表展开的那一句 */
const 展开 = (轻: readonly 轻行[], 负责人: readonly string[]) => 轻.map(([key, 时间, i]) => ({ key, 时间, ownerId: 负责人[i] }));

const 字 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-:.中文 ";
function 编号(r: () => number) {
  const n = 1 + Math.floor(r() * 30);
  return Array.from({ length: n }, () => 字[Math.floor(r() * 字.length)]).join("");
}

/** 精度：0 分钟、1 秒、2 毫秒、3 混着 */
function 造(r: () => number, 条数: number, 精度: number, 人数: number): 轻行[] {
  const 基准 = Date.UTC(2026, 9, 25);
  return Array.from({ length: 条数 }, () => {
    const 类 = r();
    let 时间: string | null;
    if (类 < 0.1) 时间 = null;
    else if (类 < 0.25) 时间 = new Date(基准 + Math.floor((r() - 0.5) * 400) * 86_400_000).toISOString().slice(0, 10);
    else if (类 < 0.28) 时间 = ["2026-10-25T09:00:00Z", "2026-10-25T09:00:00.000+08:00", "2026-10-25 09:00", "", "不是时间"][Math.floor(r() * 5)];
    else if (类 < 0.3) 时间 = new Date([-1e12, -62_198_755_200_000, 253_402_300_799_999, 8.64e15 - 60_000][Math.floor(r() * 4)]).toISOString();
    else {
      const p = 精度 === 3 ? Math.floor(r() * 3) : 精度;
      const 单位 = [60_000, 1_000, 1][p];
      时间 = new Date(基准 + Math.floor((r() - 0.3) * 1e11 / 单位) * 单位).toISOString();
    }
    return [`${r() < 0.6 ? "plan" : "task"}:${编号(r)}`, 时间, Math.floor(r() * 人数)] as 轻行;
  });
}

describe("压了再解", () => {
  for (const 种子 of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`种子 ${种子}`, () => {
      const r = 随机(种子);
      const 负责人 = Array.from({ length: 1 + Math.floor(r() * 40) }, (_, i) => `u${i}-${编号(r)}`);
      const 轻 = 造(r, 1 + Math.floor(r() * 3000), 种子 % 4, 负责人.length);
      // 同一时刻一大片、倒着排的也要对
      if (种子 % 2) 轻.push(...轻.slice(0, 200).map(([k, t, i]): 轻行 => [k + "x", t, i]), ...[...轻].reverse().slice(0, 100).map(([k, t, i]): 轻行 => [k + "y", t, i]));
      const 紧 = 压轻(轻, 负责人);
      expect(紧).not.toBeNull();
      expect(解轻(紧!)).toEqual(展开(轻, 负责人));
      // 页面拿到的是序列化过的
      expect(解轻(JSON.parse(JSON.stringify(紧)))).toEqual(展开(轻, 负责人));
    });
  }

  it("单位：都整分钟按分钟，有秒按秒，有毫秒按毫秒；日期串和空不算", () => {
    const 人 = ["a"];
    const 分 = 压轻([["plan:1", "2026-10-25T09:00:00.000Z", 0], ["plan:2", "2026-10-25", 0], ["task:3", null, 0], ["task:4", "2026-10-25T09:05:00.000Z", 0]], 人)!;
    expect(分.单位).toBe(60_000);
    expect(分.时).toEqual([Date.UTC(2026, 9, 25, 9) / 60_000, "2026-10-25", null, 5]);
    expect(压轻([["plan:1", "2026-10-25T09:00:01.000Z", 0]], 人)!.单位).toBe(1_000);
    expect(压轻([["plan:1", "2026-10-25T09:00:00.001Z", 0]], 人)!.单位).toBe(1);
  });

  it("key 里有逗号、前缀不认识：不压", () => {
    expect(压轻([["plan:a,b", null, 0]], ["u"])).toBeNull();
    expect(压轻([["plan:a", null, 0], ["note:b", null, 0]], ["u"])).toBeNull();
    expect(压轻([["plan", null, 0]], ["u"])).toBeNull();
    expect(压轻([["toStr", null, 0]], ["u"])).toBeNull();
  });

  it("企业版那种 1.5 万条：压完不到原来的 55%", () => {
    const r = 随机(99);
    const 负责人 = Array.from({ length: 30 }, (_, i) => `cmh${String(i).padStart(4, "0")}user0000000000000`.slice(0, 25));
    const id = () => "cm" + Array.from({ length: 23 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(r() * 36)]).join("");
    const 起 = Date.UTC(2026, 8, 1);
    const 计划 = Array.from({ length: 10_000 }, () => 起 + Math.floor(r() * 120 * 24 * 60) * 60_000).sort((a, b) => a - b);
    const 待办 = Array.from({ length: 5_000 }, () => 起 + Math.floor(r() * 120 * 24 * 60) * 60_000).sort((a, b) => a - b);
    const 轻: 轻行[] = [
      ...计划.map((t): 轻行 => [`plan:${id()}`, new Date(t).toISOString(), Math.floor(r() * 30)]),
      ...待办.map((t): 轻行 => [`task:${id()}`, new Date(t).toISOString(), Math.floor(r() * 30)]),
    ];
    const 紧 = 压轻(轻, 负责人)!;
    expect(解轻(紧)).toEqual(展开(轻, 负责人));
    const 原 = JSON.stringify({ 轻, 负责人 }).length;
    expect(JSON.stringify(紧).length / 原).toBeLessThan(0.55);
  });
});

describe("整页", () => {
  beforeEach(async () => {
    await resetDb();
    state.user.id = (await prisma.user.create({ data: { email: "light-me", password: "x", name: "我", role: "ADMIN" } })).id;
  });
  afterAll(async () => { await prisma.$disconnect(); });

  async function 灌(条数: number, id = (i: number) => `lp${i}`) {
    const 别人 = await prisma.user.create({ data: { email: "light-other", password: "x", name: "同事", role: "SALES" } });
    const c = await prisma.customer.create({ data: { name: "客户", phone: "13600000001", salesOwnerId: state.user.id } });
    const r = 随机(条数);
    await prisma.followPlan.createMany({
      data: Array.from({ length: 条数 }, (_, i) => {
        const d = new Date(Date.now() + Math.floor((r() - 0.5) * 40 * 24 * 60) * 60_000);
        const 只日期 = r() < 0.2;
        return { id: id(i), subject: `计划${i}`, plannedAt: d, plannedOn: 只日期 ? d.toISOString().slice(0, 10) : null, customerId: c.id, ownerId: r() < 0.5 ? state.user.id : 别人.id };
      }),
    });
    await prisma.task.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({ id: `lt${i}`, title: `待办${i}`, dueAt: i % 3 ? new Date(Date.now() + i * 3_600_000) : null, customerId: c.id, ownerId: 别人.id })),
    });
  }
  const 开 = async () => (await PlansPage({ searchParams: Promise.resolve({}) })).props as Record<string, unknown>;

  it("分批时给 紧 不给 轻，解出来就是 取计划页 的轻列表", async () => {
    await 灌(400);
    const 页 = await 取计划页(prisma, 读每组(undefined), state.user.id);
    expect(页.轻).toBeDefined();
    const props = await 开();
    expect(props.轻).toBeUndefined();
    expect(props.负责人).toBeUndefined();
    expect(解轻(props.紧 as never)).toEqual(展开(页.轻!, 页.负责人!));
    expect(props.plans).toEqual(页.plans);
    expect(props.tasks).toEqual(页.tasks);
    expect(props.每组).toEqual(读每组(undefined));
    expect(typeof props.补详情).toBe("function");
  });

  it("个人版（全取回来了）：紧、轻都不给", async () => {
    await 灌(20);
    const props = await 开();
    expect(props.紧).toBeUndefined();
    expect(props.轻).toBeUndefined();
    expect(props.每组).toBeUndefined();
  });

  it("压不了（id 里有逗号）：照原来给 轻 和 负责人", async () => {
    await 灌(400, (i) => (i === 7 ? "lp,7" : `lp${i}`));
    const 页 = await 取计划页(prisma, 读每组(undefined), state.user.id);
    const props = await 开();
    expect(props.紧).toBeUndefined();
    expect(props.轻).toEqual(页.轻);
    expect(props.负责人).toEqual(页.负责人);
  });
});
