/**
 * 二轮排查（r2-data）· 时区。
 *
 * 桌面端的本地服务跑在用户自己的电脑上，**时区是他本机的**，不一定是北京。
 * 「今天 / 本月 / 逾期 / 到点提醒 / 早报 / 首页卡片 / 数据页」都按本机日历天算——
 * 这里把同一组数据放进几个时区各跑一遍，每个时区里都按「当地的」时刻造数，数出来必须一样，
 * 而且首页 / 计划页 / Dock / 数据页彼此一致。
 *
 * 注意：vitest.config.ts 用 test.env 把 TZ 钉成了 Asia/Shanghai，**命令行上的 TZ=… 会被它盖掉**，
 * 所以这里在用例里改 process.env.TZ（Node 会当场换时区），跑完换回去。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createRequire } from "node:module";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人, 造客户, 本地 } from "./r2-data-helpers";
import { 数逾期跟进, 是逾期 } from "@/lib/overdue";
import { 取提醒项 } from "@/lib/reminders-db";
import { 算提醒, 定了时刻 } from "@/lib/reminders";
import { 截止说法 } from "@/lib/deadline";
import { 加载复盘 } from "@/app/(app)/overview/data";
import { 客户筛选条件 } from "@/app/(app)/customers/query";
import { savePlan } from "@/app/(app)/customers/[id]/actions";
import { saveContract } from "@/app/(app)/customers/actions";
import { 认日期 } from "@/lib/import/plan";
import { dayjs } from "@/lib/utils";

const 壳 = createRequire(import.meta.url)("../desktop/reminders.js");

const 原TZ = process.env.TZ;
afterAll(async () => {
  process.env.TZ = 原TZ;
  await prisma.$disconnect();
});
afterEach(() => { vi.useRealTimers(); });

function 进时区(tz: string, now: Date | (() => Date)) {
  process.env.TZ = tz;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(typeof now === "function" ? now() : now);
}

const 时区们 = ["Asia/Shanghai", "America/Los_Angeles", "UTC", "Europe/London", "Asia/Kolkata", "Pacific/Auckland"];

describe.each(时区们)("月末深夜（本地 10-31 23:30），时区 %s", (tz) => {
  let 我: string;
  beforeAll(async () => {
    process.env.TZ = tz;
    await resetDb();
    我 = (await 造本人()).id;
    mocks.user = { ...mocks.user, id: 我 };
    const c = await 造客户(我, { createdAt: 本地(2026, 10, 1, 0, 0) });
    await 造客户(我, { createdAt: 本地(2026, 9, 30, 23, 59) });
    // 计划 / 待办：全部按当地时刻造
    await prisma.followPlan.createMany({
      data: [
        { subject: "逾期的", plannedAt: 本地(2026, 10, 30, 10), customerId: c.id, ownerId: 我 },
        { subject: "今天只选了日期", plannedAt: 本地(2026, 10, 31), customerId: c.id, ownerId: 我 },
        { subject: "明早 0:30", plannedAt: 本地(2026, 11, 1, 0, 30), customerId: c.id, ownerId: 我 },
      ],
    });
    await prisma.task.create({ data: { title: "今晚 23:45", dueAt: 本地(2026, 10, 31, 23, 45), customerId: c.id, ownerId: 我 } });
    await prisma.task.create({ data: { title: "没定时间", dueAt: null, customerId: c.id, ownerId: 我 } });
    await prisma.contract.createMany({
      data: [
        { customerId: c.id, amount: 100, signedAt: 本地(2026, 10, 1, 0, 0) },
        { customerId: c.id, amount: 200, signedAt: 本地(2026, 10, 31, 23, 0) },
        { customerId: c.id, amount: 4000, signedAt: 本地(2026, 11, 1, 0, 10) },
        { customerId: c.id, amount: 8000, signedAt: 本地(2026, 9, 30, 23, 59) },
      ],
    });
  });

  const now = () => 本地(2026, 10, 31, 23, 30);

  it("（自检）进程的时区真的切过去了", () => {
    进时区(tz, now);
    const 期望偏移 = { "Asia/Shanghai": -480, "America/Los_Angeles": 420, UTC: 0, "Europe/London": 0, "Asia/Kolkata": -330, "Pacific/Auckland": -780 }[tz];
    expect(new Date().getTimezoneOffset()).toBe(期望偏移);
  });

  it("逾期：首页 / 数据页（数逾期跟进）= 计划页（是逾期）= Dock（算提醒）= 1", async () => {
    进时区(tz, now);
    const 项 = await 取提醒项(我);
    const 摘要 = 算提醒(项, new Date());
    const 计划页逾期 = 项.filter((x) => 是逾期(x.时间)).length;
    expect({ 首页: await 数逾期跟进(prisma, { ownerId: 我 }), 数据页: await 数逾期跟进(prisma), 计划页: 计划页逾期, Dock: 摘要.逾期 })
      .toEqual({ 首页: 1, 数据页: 1, 计划页: 1, Dock: 1 });
  });

  it("今天：Dock 的「今天」= 计划页「今天」那一组 = 2（只选日期的那条 + 今晚 23:45）", async () => {
    进时区(tz, now);
    const 项 = await 取提醒项(我);
    const 摘要 = 算提醒(项, new Date());
    const 今天结束 = dayjs().endOf("day");
    const 计划页今天 = 项.filter((x) => x.时间 && !是逾期(x.时间) && dayjs(x.时间).isBefore(今天结束)).length;
    expect({ Dock: 摘要.今天, 计划页: 计划页今天 }).toEqual({ Dock: 2, 计划页: 2 });
  });

  it("到点提醒：今晚 23:45 和明早 0:30 会叫；只选了日期的那条不在半夜叫", async () => {
    进时区(tz, now);
    const 摘要 = 算提醒(await 取提醒项(我), new Date());
    expect(摘要.定时.map((x) => x.标题)).toEqual(["今晚 23:45", "明早 0:30"]);
  });

  it("早报：设 09:00，今天（当地 10-31）发过就不再发；跨过当地零点算新的一天", () => {
    进时区(tz, now);
    const 设置 = 壳.规整设置({});
    const 摘要 = { 逾期: 1, 今天: 2, 定时: [], 最久: null };
    expect(壳.今天串(new Date())).toBe("2026-10-31");
    expect(壳.该发早报(设置, { 早报日: "2026-10-31", 已提醒: [] }, 摘要, new Date())).toBe(false);
    expect(壳.该发早报(设置, { 早报日: "2026-10-30", 已提醒: [] }, 摘要, new Date())).toBe(true);
    expect(壳.该发早报(设置, { 早报日: "2026-10-31", 已提醒: [] }, 摘要, 本地(2026, 11, 1, 9, 1))).toBe(true);
  });

  it("本月签约：数据页「本月」合计 = 首页口径 = 300（月初零点那笔算、下月 0:10 和上月 23:59 不算）", async () => {
    进时区(tz, now);
    const n = dayjs();
    const 复盘 = await 加载复盘(n.startOf("month").toDate(), n.endOf("month").toDate(), "day");
    const 首页 = await prisma.contract.aggregate({ _sum: { amount: true }, where: { signedAt: { gte: n.startOf("month").toDate(), lt: n.endOf("month").toDate() } } });
    const 数据卡 = await prisma.contract.aggregate({ _sum: { amount: true }, where: { signedAt: { gte: n.startOf("month").toDate(), lt: n.add(1, "month").startOf("month").toDate() } } });
    expect({ 数据页本月: 复盘.total.amount, 首页: 首页._sum.amount, 数据卡: 数据卡._sum.amount }).toEqual({ 数据页本月: 300, 首页: 300, 数据卡: 300 });
    // 趋势图第一根是 1 号、最后一笔落在 31 号
    expect(复盘.trend[0].label).toBe("10-01");
    expect(复盘.trend.find((b) => b.label === "10-31")?.amount).toBe(200);
  });

  it("客户列表「本月新增」：月初零点建的算、上月 23:59 的不算", async () => {
    进时区(tz, now);
    expect(await prisma.customer.count({ where: await 客户筛选条件({ createdWithin: "本月" }) })).toBe(1);
  });

  it("截止说法：前天上午的计划写「逾期 1 天」、今晚的写「今天 23:45」、明早的写「明天 00:30」", () => {
    进时区(tz, now);
    expect(截止说法(本地(2026, 10, 30, 10))).toBe("逾期 1 天");
    expect(截止说法(本地(2026, 10, 31, 23, 45))).toBe("今天 23:45");
    expect(截止说法(本地(2026, 11, 1, 0, 30))).toBe("明天 00:30");
  });

  it("导入的日期（文本和 Excel 序列号）落在当地那一天", () => {
    进时区(tz, now);
    for (const v of ["2026-10-31", "46326"]) {
      const d = 认日期(v)!;
      expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours()], v).toEqual([2026, 10, 31, 0]);
    }
  });

  it("签约查重的「同一天」按当地日历天：当地 23:00 和当地次日 00:10 不算同一天", async () => {
    进时区(tz, now);
    const c = await prisma.customer.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    await prisma.contract.deleteMany({ where: { customerId: c.id } });
    const 一 = await saveContract({ customerId: c.id, amount: 999, signedAt: 本地(2026, 10, 31, 23, 0), remark: null });
    const 二 = await saveContract({ customerId: c.id, amount: 999, signedAt: 本地(2026, 11, 1, 0, 10), remark: null });
    const 三 = await saveContract({ customerId: c.id, amount: 999, signedAt: 本地(2026, 10, 31, 8, 0), remark: null });
    expect([一.ok, 二.ok, "duplicate" in 三]).toEqual([true, true, true]);
  });
});

describe("夏令时", () => {
  it("洛杉矶 11-01 夏令时结束那天（一天 25 小时）：逾期天数、今天、到点都对", async () => {
    process.env.TZ = "America/Los_Angeles";
    await resetDb();
    const 我 = (await 造本人()).id;
    const c = await 造客户(我);
    await prisma.followPlan.createMany({
      data: [
        { subject: "一周前", plannedAt: 本地(2026, 10, 25, 10), customerId: c.id, ownerId: 我 },
        { subject: "1:30（这天出现两次的时刻）", plannedAt: 本地(2026, 11, 1, 1, 30), customerId: c.id, ownerId: 我 },
        { subject: "晚上 22:00", plannedAt: 本地(2026, 11, 1, 22, 0), customerId: c.id, ownerId: 我 },
      ],
    });
    进时区("America/Los_Angeles", 本地(2026, 11, 1, 12, 0));
    const 摘要 = 算提醒(await 取提醒项(我), new Date());
    expect({ 逾期: 摘要.逾期, 今天: 摘要.今天, 最久: 摘要.最久?.天, 定时: 摘要.定时.map((x) => x.标题) })
      .toEqual({ 逾期: 1, 今天: 2, 最久: 7, 定时: ["晚上 22:00"] });
    expect(截止说法(本地(2026, 10, 25, 10))).toBe("逾期 7 天");
  });

  it("伦敦 3-29 夏令时开始那天（一天 23 小时）：前一天的计划是「逾期 1 天」", () => {
    进时区("Europe/London", 本地(2026, 3, 29, 9, 0));
    expect(截止说法(本地(2026, 3, 28, 9, 0))).toBe("逾期 1 天");
    expect(是逾期(本地(2026, 3, 28, 23, 59))).toBe(true);
    expect(是逾期(本地(2026, 3, 29, 0, 0))).toBe(false);
  });

  it("D-047 圣地亚哥午夜不存在：新日期计划不在01:00弹，明确01:00会提醒", async () => {
    process.env.TZ = "America/Santiago";
    await resetDb(); const 我 = (await 造本人()).id; mocks.user.id = 我; const c = await 造客户(我);
    进时区("America/Santiago", () => 本地(2026, 9, 6, 1, 0));
    expect((await savePlan({ customerId: c.id, subject: "只选日期", plannedAt: "2026-09-06", method: "电话" })).ok).toBe(true);
    expect((await savePlan({ customerId: c.id, subject: "明确一点", plannedAt: "2026-09-06T01:00:00-03:00", method: "电话" })).ok).toBe(true);
    const 项 = await 取提醒项(我); const 日期 = 项.find(x => x.标题 === "只选日期")!;
    expect(日期.时间!.getHours()).toBe(1);
    expect(定了时刻(日期.时间!, 日期.明确钟点)).toBe(false);
    expect(算提醒(项).定时.map(x => x.标题)).toEqual(["明确一点"]);
  });
});
