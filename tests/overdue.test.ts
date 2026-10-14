/**
 * 「逾期跟进」三处一个数（lib/overdue.ts）。
 *
 * 2026-09-28 交互审查 M1：首页写「逾期跟进 4 · 先处理」，点进去计划页是「逾期 6」，
 * 数据页那张卡也是 6——首页只数了计划，另外两处把待办也算上了。
 * 产品拍板：**计划 + 待办都算**。钉两件事：
 *   1. 口径本身：计划和待办都算、做完的不算、没定时间的不算、按本地今天零点切
 *   2. 三处都从 lib/overdue.ts 取，不许再各写一份 where
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 是逾期, 逾期条件, 数逾期跟进, 今天零点 } from "@/lib/overdue";

/** 2026-09-28（周一）下午 3 点，本机时区 */
const 现在 = new Date(2026, 8, 28, 15, 0);

type 计划 = { ownerId: string; done: boolean; plannedAt: Date };
type 待办 = { ownerId: string; done: boolean; dueAt: Date | null };

const 计划们: 计划[] = [
  { ownerId: "me", done: false, plannedAt: new Date(2026, 8, 24, 10) }, // 逾期
  { ownerId: "me", done: false, plannedAt: new Date(2026, 8, 27, 23, 59) }, // 昨天夜里，逾期
  { ownerId: "me", done: false, plannedAt: new Date(2026, 8, 28, 9) }, // 今天上午，钟点过了也不算逾期
  { ownerId: "me", done: true, plannedAt: new Date(2026, 8, 20, 10) }, // 做完了
  { ownerId: "他", done: false, plannedAt: new Date(2026, 8, 26, 10) }, // 别人的逾期
];
const 待办们: 待办[] = [
  { ownerId: "me", done: false, dueAt: new Date(2026, 8, 25, 17) }, // 逾期
  { ownerId: "me", done: false, dueAt: new Date(2026, 8, 26, 18) }, // 逾期
  { ownerId: "me", done: false, dueAt: null }, // 没定时间：计划页放「以后」
  { ownerId: "me", done: false, dueAt: new Date(2026, 8, 29, 9) }, // 明天
  { ownerId: "他", done: true, dueAt: new Date(2026, 8, 1) }, // 别人做完的
];

/** 照 prisma 的语义在内存里跑 where：只认 逾期条件() 会用到的那几种写法 */
function 合(where: Record<string, unknown>, row: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR" && Array.isArray(v)) return v.some(condition => 合(condition, row));
    if (v === null) return row[k] == null;
    if (v && typeof v === "object" && "lt" in v) {
      const x = row[k] as Date | null;
      return x !== null && x < (v as { lt: Date }).lt;
    }
    return row[k] === v;
  });
}
const 假库 = {
  followPlan: { count: async ({ where }: { where: Record<string, unknown> }) => 计划们.filter((r) => 合(where, r)).length },
  task: { count: async ({ where }: { where: Record<string, unknown> }) => 待办们.filter((r) => 合(where, r)).length },
};

/** 计划页的做法：把两张表的未完成事项摊平，按 是逾期() 分组（PlansView 的「逾期」一组） */
function 计划页逾期(ownerId?: string): number {
  const 全部 = [
    ...计划们.filter((p) => !p.done).map((p) => ({ ownerId: p.ownerId, 时间: p.plannedAt.toISOString() })),
    ...待办们.filter((t) => !t.done).map((t) => ({ ownerId: t.ownerId, 时间: t.dueAt?.toISOString() ?? null })),
  ];
  return 全部.filter((x) => (ownerId ? x.ownerId === ownerId : true)).filter((x) => 是逾期(x.时间, 现在)).length;
}

describe("口径：计划 + 待办都算", () => {
  it("我的：2 条计划 + 2 条待办 = 4；做完的、今天的、明天的、没定时间的都不算", async () => {
    expect(await 数逾期跟进(假库, { ownerId: "me" }, 现在)).toBe(4);
  });

  it("全团队：再加上别人的那条", async () => {
    expect(await 数逾期跟进(假库, {}, 现在)).toBe(5);
  });

  it("首页点「先处理」进计划页（我的），看到的数和首页一样；数据页（全部成员）也一样", async () => {
    expect(计划页逾期("me")).toBe(await 数逾期跟进(假库, { ownerId: "me" }, 现在));
    expect(计划页逾期()).toBe(await 数逾期跟进(假库, {}, 现在));
  });

  it("按本地今天零点切：昨天 23:59 算逾期，今天 00:00 不算", () => {
    expect(是逾期(new Date(2026, 8, 27, 23, 59), 现在)).toBe(true);
    expect(是逾期(new Date(2026, 8, 28, 0, 0), 现在)).toBe(false);
    expect(是逾期(null, 现在)).toBe(false);
    expect(今天零点(现在)).toEqual(new Date(2026, 8, 28));
    expect(逾期条件({}, 现在).plan.OR[1].plannedAt!.lt).toEqual(new Date(2026, 8, 28));
    expect(逾期条件({ ownerId: "me" }, 现在).task).toEqual({ ownerId: "me", done: false, OR: [{ dueOn: { lt: "2026-09-28" } }, { dueOn: null, dueAt: { lt: new Date(2026, 8, 28) } }] });
  });
});

describe("三处都从 lib/overdue.ts 取，不许再各写一份", () => {
  const 读 = (rel: string) => fs.readFileSync(path.resolve(__dirname, "../src", rel), "utf8");

  it("首页信号：数逾期跟进，只数我的", () => {
    const s = 读("app/(app)/dashboard/page.tsx");
    expect(s).toMatch(/数逾期跟进\(prisma, \{ ownerId: user\.id \}\)/);
  });

  it("数据页那张卡：数逾期跟进，全团队", () => {
    const s = 读("app/(app)/dashboard/Board.tsx");
    expect(s).toMatch(/数逾期跟进\(prisma\)/);
    expect(s).not.toMatch(/plannedAt:\s*\{\s*lt:/);
    expect(s).not.toMatch(/dueAt:\s*\{\s*lt:/);
  });

  it("计划页的「逾期」一组：用 是逾期() 分", () => {
    const s = 读("app/(app)/follow-ups/plans/PlansView.tsx");
    expect(s).toMatch(/if \(是逾期\(x\.时间\)\) out\.逾期\.push\(x\)/);
  });
});
