/**
 * 复盘趋势图的横轴：**没签约的那天也得占一个刻度**。
 *
 * 2026-09-19 报上来的：9/1、9/5、9/19 各签一单，图上就是三根挨着的柱子——
 * 中间那十几个空白的日子根本不在横轴上，读起来像天天在签。
 * 柱状图的横轴是等距的，缺刻度不是「少画一根」，是把时间轴本身压缩了。
 *
 * 另一头也得钉住：**不许往未来铺**。本月视图的 to 是月末，
 * 把还没到的日子铺成 0，右边会拖出一条贴底的长尾，同样是在说一件没发生的事。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 加载复盘 } from "../src/app/(app)/overview/data";

let sales: { id: string };
let 学员: { id: string };

async function 签(日: string, 金额: number, 谁 = 学员.id) {
  await prisma.contract.create({ data: { customerId: 谁, amount: 金额, signedAt: new Date(`${日}T10:00:00`) } });
}

beforeEach(async () => {
  await resetDb();
  sales = await prisma.user.create({
    data: { email: `s${Date.now()}@t.com`, password: "x", name: "张三", role: "SALES" },
  });
  学员 = await prisma.customer.create({
    data: { name: "钱同学", phone: "13900000001", salesOwnerId: sales.id },
  });
});

afterAll(async () => void (await prisma.$disconnect()));

/** 取一个已经过完的月份，这样「铺到今天为止」不会把它截短 */
const 上个月 = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return { 年: d.getFullYear(), 月: d.getMonth() + 1 };
};

describe("按天铺开的趋势", () => {
  it("中间没签约的日子也在横轴上，值是 0", async () => {
    const { 年, 月 } = 上个月();
    const p = (n: number) => String(n).padStart(2, "0");
    await 签(`${年}-${p(月)}-01`, 10000);
    await 签(`${年}-${p(月)}-05`, 20000);

    const 数 = await 加载复盘(
      new Date(`${年}-${p(月)}-01T00:00:00`),
      new Date(`${年}-${p(月)}-08T00:00:00`),
      "day",
    );

    // 01 到 07 七天，一天都不能少（to 是开区间，08 当天不算）
    expect(数.trend.map((t) => t.label)).toEqual([1, 2, 3, 4, 5, 6, 7].map((d) => `${p(月)}-${p(d)}`));
    expect(数.trend.map((t) => t.amount)).toEqual([10000, 0, 0, 0, 20000, 0, 0]);
    expect(数.trend.map((t) => t.count)).toEqual([1, 0, 0, 0, 1, 0, 0]);
  });

  it("不往未来铺：还没到的日子不占刻度", async () => {
    const now = new Date();
    const 月初 = new Date(now.getFullYear(), now.getMonth(), 1);
    const 月末 = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const 数 = await 加载复盘(月初, 月末, "day");
    // 最多到今天。铺到月末的话，月中打开这一页右边会挂一条贴底的长尾
    expect(数.trend.length).toBe(now.getDate());
  });

  it("一条签约都没有时，刻度照铺，值全是 0", async () => {
    const { 年, 月 } = 上个月();
    const p = (n: number) => String(n).padStart(2, "0");
    const 数 = await 加载复盘(new Date(`${年}-${p(月)}-01T00:00:00`), new Date(`${年}-${p(月)}-04T00:00:00`), "day");
    expect(数.trend.length).toBe(3);
    expect(数.total.count).toBe(0);
    // 界面据 total.count 判空态：trend 不空了，不能再拿它当「有没有签约」的判据
    expect(数.trend.every((t) => t.amount === 0)).toBe(true);
  });
});

describe("按月铺开的趋势", () => {
  it("跨月时每个月都在，31 号起步也不会跳过短月", async () => {
    await 签("2024-01-31", 5000);
    await 签("2024-03-15", 7000);
    const 数 = await 加载复盘(new Date("2024-01-31T00:00:00"), new Date("2024-04-01T00:00:00"), "month");
    expect(数.trend.map((t) => t.label)).toEqual(["2024-01", "2024-02", "2024-03"]);
    expect(数.trend.map((t) => t.amount)).toEqual([5000, 0, 7000]);
  });
});

describe("客单价按人算，不是按笔算", () => {
  it("同一位学员签两笔，客单价是总额除以 1", async () => {
    const { 年, 月 } = 上个月();
    const p = (n: number) => String(n).padStart(2, "0");
    await 签(`${年}-${p(月)}-02`, 10000);
    await 签(`${年}-${p(月)}-03`, 30000);

    const 数 = await 加载复盘(
      new Date(`${年}-${p(月)}-01T00:00:00`),
      new Date(`${年}-${p(月)}-10T00:00:00`),
      "day",
    );
    expect(数.total).toEqual({ amount: 40000, count: 2 });
    // 界面按明细里的学员 id 去重来算人数（见 ReportsView）——这里钉住它数得出 1 位
    const 人数 = new Set(Object.values(数.明细).flat().map((r) => r.学员id)).size;
    expect(人数).toBe(1);
    // 按笔算是 20000，按人算是 40000。卡片上写的是「客单价」
    expect(Math.round(数.total.amount / 人数)).toBe(40000);
  });
});
