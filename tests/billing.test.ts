/**
 * 订阅与续费。
 *
 * 这一块算错就是钱的问题，而且两个方向都糟：少算了用户吃亏、投诉；
 * 多算了我们吃亏、还很难发现。续费顺延是最容易写错的一处——
 * 从「今天」重算会把用户已经付过的天数直接吃掉。
 */
import { describe, it, expect } from "vitest";
import { PLANS, isPlanKey } from "@/lib/tenant/plans";
import { computeWritable, daysLeft } from "@/lib/tenant/workspaces";

const 天 = 86_400_000;

/** 与 admin/actions.ts 的 activate 同一套算法，单独拎出来验 */
function 顺延(paidUntil: Date | null, plan: keyof typeof PLANS, now: Date): Date {
  const base = paidUntil && paidUntil > now ? paidUntil : now;
  return new Date(base.getTime() + PLANS[plan].days * 天);
}

const 此刻 = new Date("2026-09-13T00:00:00Z");

describe("套餐", () => {
  it("两档都有价格和天数，天数为正", () => {
    for (const k of Object.keys(PLANS) as (keyof typeof PLANS)[]) {
      expect(PLANS[k].price).toBeGreaterThan(0);
      expect(PLANS[k].days).toBeGreaterThan(0);
    }
  });

  it("年付要比按月付 12 次便宜，否则没人会选年付", () => {
    expect(PLANS.year.price).toBeLessThan(PLANS.month.price * 12);
  });

  it("只认已知的套餐键，编的要拒——它决定加多少天", () => {
    expect(isPlanKey("year")).toBe(true);
    expect(isPlanKey("forever")).toBe(false);
    expect(isPlanKey(null)).toBe(false);
  });
});

describe("续费顺延", () => {
  it("没付过就从今天算", () => {
    expect(顺延(null, "month", 此刻).getTime()).toBe(此刻.getTime() + PLANS.month.days * 天);
  });

  it("还没到期时从原到期日往后加，不吃掉已付的天数", () => {
    const 还剩100天 = new Date(此刻.getTime() + 100 * 天);
    const 结果 = 顺延(还剩100天, "year", 此刻);
    expect(结果.getTime()).toBe(还剩100天.getTime() + PLANS.year.days * 天);
    // 具体说：续一年之后应该是 100 + 365 天之后，而不是 365 天之后
    expect(Math.round((结果.getTime() - 此刻.getTime()) / 天)).toBe(100 + PLANS.year.days);
  });

  it("已经过期了就从今天算，不倒贴过期那段", () => {
    const 早就过期 = new Date(此刻.getTime() - 60 * 天);
    expect(顺延(早就过期, "month", 此刻).getTime()).toBe(此刻.getTime() + PLANS.month.days * 天);
  });
});

describe("开通之后的状态", () => {
  it("付费后立刻可写，试用早过了也一样", () => {
    const paidUntil = 顺延(null, "year", 此刻);
    expect(computeWritable({ status: "ACTIVE", trialEndsAt: new Date(此刻.getTime() - 30 * 天), paidUntil }, 此刻)).toBe(true);
  });

  it("剩余天数按付费到期日显示", () => {
    const paidUntil = 顺延(null, "month", 此刻);
    expect(daysLeft({ trialEndsAt: new Date(此刻.getTime() - 30 * 天), paidUntil }, 此刻)).toBe(PLANS.month.days);
  });
});

/**
 * 订阅页现在**不许出现价格、人数、权益**（批 5）。
 *
 * 定价还没定（2026-09 拍板：不接支付、托管版只做试用通道）。
 * 页面上一旦写了「¥1980 / 年 · 不限成员 · 含全部 AI 功能」，它就是在替产品定价，
 * 而改口的代价比空着大得多——官网、老客户、发票抬头都得跟着动。
 * 后端那套续费天数照旧（上面那几条测的就是它），只是界面上不摆。
 */
describe("订阅页不替产品定价", () => {
  it("BillingView 里没有价格、人数、权益的字样", async () => {
    const fs = await import("node:fs/promises");
    const src = (await fs.readFile("src/app/(app)/billing/BillingView.tsx", "utf8"))
      // 注释里会引用「原来是怎么写的」来说明为什么删掉，不算
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    const 犯规 = [
      [/PLANS\[[^\]]+\]\.price/, "把套餐价格渲染到了页面上"],
      [/¥\s*\{/, "模板里插了一个金额"],
      [/不限成员|人数不限/, "写了人数权益"],
      [/含全部 ?AI|全部功能/, "写了功能权益"],
    ].filter(([re]) => (re as RegExp).test(src)).map(([, why]) => why);

    expect(犯规, `订阅页又开始替产品定价了：${犯规.join("、")}`).toEqual([]);
  });
});
