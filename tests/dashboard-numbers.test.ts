/**
 * 首页 / 数据看板交给界面的那几个数（2026-10-04 回归核对 J-109 / J-110 / J-111 / J-123）。
 *
 * Board 和首页 page 都是服务端组件：取数、算数都在里面，最后把结果当 props 交给 DashboardView / HomeChat。
 * 这里把两个视图换成桩，直接调服务端组件拿到它交出去的 props——钉的是「交给界面的是什么数」，
 * 不起浏览器也不画图。
 *
 *   J-109 趋势图第一条线是**累计**客户数（图例写「累计客户」），不是当日新增
 *   J-110 「近期跟进任务」没日期的待办排在最后，不把逾期的挤出前 5
 *   J-111 上月 0 位新增时不给环比（原来给 0，界面写「较上月 持平」）
 *   J-123 配了 AI 的首页，输入框下的建议问题 4–6 条
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null },
  ai: false,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`redirect ${u}`); } }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));
vi.mock("@/lib/llm", () => ({ llmEnabled: async () => mocks.ai, listModelOptions: async () => [] }));
vi.mock("@/lib/onboarding", () => ({ 要选模版: async () => false }));
// 两个视图换成桩：只要服务端组件交出去的 props
vi.mock("@/app/(app)/dashboard/DashboardView", () => ({ default: () => null }));
vi.mock("@/app/(app)/dashboard/HomeChat", () => ({ default: () => null }));
vi.mock("@/app/(app)/dashboard/StartCard", () => ({ default: () => null }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人, 造客户 } from "./r2-data-helpers";
import Board from "@/app/(app)/dashboard/Board";
import DashboardPage from "@/app/(app)/dashboard/page";
import { dayjs } from "@/lib/utils";

type 元素 = { props: Record<string, unknown> };

it("J114 有30条线索但零客户时，AI首页不是空库并给出线索下一步", async () => {
  mocks.ai = true;
  await prisma.lead.createMany({data:Array.from({length:30},(_,i)=>({name:`QA线索${i}`,ownerId:我,status:"待跟进"}))});
  const el = await DashboardPage({searchParams:Promise.resolve({})});
  expect(el.props.空库).toBe(false);
  expect(el.props.suggestions).toEqual(expect.arrayContaining([expect.objectContaining({label:"跟进手上的线索"})]));
  expect(el.props.context).toContain("30 条线索");
  expect(await prisma.customer.count()).toBe(0);
});

let 我: string;
beforeEach(async () => {
  await resetDb();
  我 = (await 造本人()).id;
  mocks.user = { ...mocks.user, id: 我 };
  mocks.ai = false;
});
afterAll(async () => { await prisma.$disconnect(); });

async function 看板props() {
  return ((await Board({})) as unknown as 元素).props as {
    stats: { newCustomersThisMonth: number; newCustomersDelta: number | null };
    trend: { label: string; created: number; active: number }[];
    tasks: { id: string; title: string; dueAt: string | null }[];
  };
}

describe("J-109 趋势图：第一条线是累计客户，不是当日新增", () => {
  it("90 天里不同日子各建几位：每天的值只增不减，最后一天 = 库里总数；图例写「累计客户」", async () => {
    for (const 天前 of [80, 80, 40, 10, 0]) {
      await 造客户(我, { createdAt: dayjs().subtract(天前, "day").toDate() });
    }
    const { trend } = await 看板props();
    expect(trend).toHaveLength(90);
    for (let i = 1; i < trend.length; i++) {
      expect(trend[i].created, `${trend[i].label} 比前一天少了——这不是累计`).toBeGreaterThanOrEqual(trend[i - 1].created);
    }
    expect(trend[trend.length - 1].created).toBe(5);
    // 第 10 天前那位建好之后的某一天（没人新建）照样是 4，不是 0
    expect(trend[trend.length - 5].created).toBe(4);
    // 图例名和口径一致：DashboardView 里那条线叫「累计客户」，不叫「新增客户」
    const 视图 = readFileSync("src/app/(app)/dashboard/DashboardView.tsx", "utf8");
    expect(视图).toMatch(/data:\s*\["累计客户",\s*"活跃客户"\]/);
    expect(视图).not.toMatch(/name:\s*"新增客户"/);
  });
});

describe("J-110 近期跟进任务：没日期的排最后", () => {
  it("3 条没日期 + 3 条逾期待办：取前 5 时逾期的 3 条都在、排在前面", async () => {
    const c = await 造客户(我);
    for (let i = 0; i < 3; i++) await prisma.task.create({ data: { title: `没日期${i}`, customerId: c.id, ownerId: 我 } });
    for (let i = 0; i < 3; i++) {
      await prisma.task.create({ data: { title: `逾期${i}`, customerId: c.id, ownerId: 我, dueAt: dayjs().subtract(i + 1, "day").toDate() } });
    }
    const { tasks } = await 看板props();
    expect(tasks).toHaveLength(5);
    expect(tasks.slice(0, 3).map((t) => t.title).sort()).toEqual(["逾期0", "逾期1", "逾期2"]);
    expect(tasks.slice(3).every((t) => t.dueAt === null)).toBe(true);
  });
});

describe("J-111 新增客户环比", () => {
  it("上月 0 位、本月 5 位：环比给 null（界面写「上月没有新增」），不是 0（「较上月 持平」）", async () => {
    for (let i = 0; i < 5; i++) await 造客户(我);
    const { stats } = await 看板props();
    expect(stats.newCustomersThisMonth).toBe(5);
    expect(stats.newCustomersDelta).toBeNull();
    const 视图 = readFileSync("src/app/(app)/dashboard/DashboardView.tsx", "utf8");
    expect(视图).toContain("newCustomersDelta === null ? \"上月没有新增\"");
  });

  it("上月 2 位、本月 3 位：环比 +50", async () => {
    const 上月 = dayjs().subtract(1, "month").startOf("month").add(3, "day").toDate();
    for (let i = 0; i < 2; i++) await 造客户(我, { createdAt: 上月 });
    for (let i = 0; i < 3; i++) await 造客户(我);
    const { stats } = await 看板props();
    expect(stats.newCustomersDelta).toBe(50);
  });
});

describe("J-123 配了 AI 的首页：建议问题 4–6 条", () => {
  async function 建议() {
    mocks.ai = true;
    const el = (await DashboardPage({ searchParams: Promise.resolve({}) })) as unknown as 元素;
    return el.props.suggestions as { label: string }[];
  }

  it("只有一位客户、没计划没跟进：靠兜底补到至少 4 条", async () => {
    await 造客户(我);
    const s = await 建议();
    expect(s.length).toBeGreaterThanOrEqual(4);
    expect(s.length).toBeLessThanOrEqual(6);
  });

  it("计划、跟进、盯盘都有：最多 6 条，不会越堆越长", async () => {
    for (let i = 0; i < 4; i++) {
      const c = await 造客户(我, { followStatus: "意向较高" });
      await prisma.followPlan.create({ data: { customerId: c.id, ownerId: 我, subject: "回访", method: "电话沟通", plannedAt: dayjs().subtract(3, "day").toDate() } });
      await prisma.followUp.create({ data: { customerId: c.id, ownerId: 我, type: "PHONE", title: "聊过", content: "聊过", status: "已完成", occurredAt: dayjs().subtract(20, "day").toDate() } });
    }
    const s = await 建议();
    expect(s.length).toBeGreaterThanOrEqual(4);
    expect(s.length).toBeLessThanOrEqual(6);
  });
});
