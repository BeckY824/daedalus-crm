/**
 * 左栏「跟进」上的红数字改在库里数（lib/reminders-db.ts 数提醒）：每个页面都走 layout，
 * 不能再把名下没做的计划和待办整份拉回来。这里对拍：数提醒() 和 算提醒(取提醒项()) 的 逾期 / 今天 必须一样，
 * 包括按日历日比的、空串日历日、没排时间的待办、零点和明天零点那两个边上、做完的、别人的。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人, 造客户 } from "./r2-data-helpers";
import { 算提醒, 今天界线 } from "@/lib/reminders";
import { 取提醒项, 数提醒 } from "@/lib/reminders-db";

const 现在 = new Date(2026, 9, 10, 9, 30);

describe("数提醒 和 算提醒(取提醒项) 一个口径", () => {
  let 我 = "", 别人 = "", 客户 = "";
  beforeEach(async () => {
    await resetDb();
    我 = (await 造本人()).id;
    别人 = (await prisma.user.create({ data: { email: "other@local", name: "别人", role: "SALES", password: "x" } })).id;
    客户 = (await 造客户(我)).id;
  });
  afterAll(() => prisma.$disconnect());

  it("各种时间、日历日、边界都数得一样", async () => {
    const { 今天开始, 明天开始, 今天串 } = 今天界线(现在);
    const 时 = (h: number) => new Date(今天开始.getTime() + h * 3_600_000);
    const 昨天串 = "2026-10-09", 明天串 = "2026-10-11";
    const 计划: [Date, string | null, boolean?, string?][] = [
      [时(-30), null], [时(-1), null], [今天开始, null], [时(10), null], [new Date(明天开始.getTime() - 1), null], [明天开始, null], [时(50), null],
      // 有日历日的按日历日：时间故意和它对不上
      [时(30), 昨天串], [时(-30), 今天串], [时(-30), 明天串],
      // 空串日历日当没有
      [时(-5), ""], [时(5), ""], [时(40), ""],
      // 做完的、别人的不算
      [时(-30), null, true], [时(5), 今天串, true], [时(-30), null, false, "别人"], [时(5), null, false, "别人"],
    ];
    for (const [plannedAt, plannedOn, done, 谁] of 计划) {
      await prisma.followPlan.create({ data: { subject: "计划", plannedAt, plannedOn, done: !!done, customerId: 客户, ownerId: 谁 ? 别人 : 我 } });
    }
    const 待办: [Date | null, string | null, boolean?][] = [
      [null, null], [null, 今天串], [null, 昨天串],
      [时(-30), null], [今天开始, null], [时(23), null], [明天开始, null],
      [时(30), 昨天串], [时(-30), 今天串], [时(-30), 明天串],
      [时(-5), ""], [时(5), ""],
      [时(-30), null, true],
    ];
    for (const [dueAt, dueOn, done] of 待办) {
      await prisma.task.create({ data: { title: "待办", dueAt, dueOn, done: !!done, customerId: 客户, ownerId: 我 } });
    }
    const 全拉 = 算提醒(await 取提醒项(我), 现在);
    const 数的 = await 数提醒(我, 现在);
    expect(数的).toEqual({ 逾期: 全拉.逾期, 今天: 全拉.今天 });
    // 钉一下绝对值，免得两边一起错还对得上
    expect(数的).toEqual({ 逾期: 7, 今天: 9 }); // 计划 4 + 待办 3；计划 5 + 待办 4
  });

  it("名下什么都没有：两个 0", async () => {
    expect(await 数提醒(我, 现在)).toEqual({ 逾期: 0, 今天: 0 });
  });
});
