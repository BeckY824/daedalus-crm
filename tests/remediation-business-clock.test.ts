import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import path from "node:path";
import { aiUsageThisMonth } from "@/lib/ai-usage";
import { 加载复盘 } from "@/app/(app)/overview/data";
import { runWithTenant } from "@/lib/tenant/context";
import { dropWorkspaceClient } from "@/lib/tenant/clients";
import nativeDayjs from "dayjs";
import { businessDayjs, configureBrowserBusinessTimeZone } from "@/lib/business-clock";
import { dayjs, fmtDateTime, smartTime, 冷热 } from "@/lib/utils";
import { 今天零点, 是逾期, 数逾期跟进 } from "@/lib/overdue";
import { calendarDay, calendarDaysBetween } from "@/lib/schedule-date";
import { 算提醒, 定了时刻 } from "@/lib/reminders";
import { 截止说法 } from "@/lib/deadline";
import { parseDateInput } from "@/lib/date-input";
import { 节点灯, 默认订单号 } from "@/lib/order";
import { 过期了 } from "@/lib/supplier";
import { defaultClient as db } from "@/lib/prisma";
import { resetDb } from "./reset";
const originalTZ = process.env.TZ;
const now = new Date("2026-10-31T16:30:00Z");
beforeEach(() => { vi.stubEnv("TZ", "America/New_York"); vi.stubEnv("MULTI_TENANT", "1"); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); });
afterEach(async () => { await dropWorkspaceClient("test.db"); vi.useRealTimers(); vi.unstubAllEnvs(); process.env.TZ = originalTZ; });
afterAll(async () => { await db.$disconnect(); });
it("托管版在纽约主机仍以北京决定今天/月边界、日期解析和无偏移钟点", () => {
  expect(dayjs().format("YYYY-MM-DD HH:mm")).toBe("2026-11-01 00:30");
  expect(dayjs().format("Z")).toBe("+08:00");
  expect(dayjs().valueOf()).toBe(now.getTime()); expect(dayjs().toDate()).toEqual(now);
  expect(JSON.stringify(dayjs())).toBe(JSON.stringify(now.toISOString()));
  expect(dayjs().clone().add(1, "hour").diff(dayjs(), "hour")).toBe(1);
  expect(dayjs().isSame("2026-11-01", "day")).toBe(true);
  expect(dayjs("2026-11-01").diff("2026-10-31", "day")).toBe(1);
  expect(dayjs().isSame(dayjs("2026-11-01"), "day")).toBe(true);
  expect(nativeDayjs().format("YYYY-MM-DD HH:mm")).toBe("2026-10-31 12:30");
  expect(dayjs().startOf("month").toISOString()).toBe("2026-10-31T16:00:00.000Z");
  expect(今天零点(now).toISOString()).toBe("2026-10-31T16:00:00.000Z");
  expect(calendarDay(now)).toBe("2026-11-01");
  expect(dayjs().add(1, "day").toISOString()).toBe("2026-11-01T16:30:00.000Z");
  expect(dayjs().hour(2).minute(15).toISOString()).toBe("2026-10-31T18:15:00.000Z");
  expect(dayjs("2026-03-08T00:30").add(1, "day").hour(2).toISOString()).toBe("2026-03-08T18:30:00.000Z");
  expect(dayjs("2026-11-02").subtract(1, "day").toISOString()).toBe("2026-10-31T16:00:00.000Z");
  expect(parseDateInput("2026-11-01")!.toISOString()).toBe("2026-10-31T16:00:00.000Z");
  expect(parseDateInput("2026-11-01T02:30")!.toISOString()).toBe("2026-10-31T18:30:00.000Z");
  expect(parseDateInput("2026-02-30")).toBeNull();
  expect(parseDateInput("2026-11-01T02:30:00-05:00")!.toISOString()).toBe("2026-11-01T07:30:00.000Z");
  configureBrowserBusinessTimeZone(null); expect(businessDayjs().format("YYYY-MM-DD")).toBe("2026-11-01");
});
it("逾期/日历天/Dock汇总/显示/订单和供应报价采用同一业务日", () => {
  expect(是逾期("2026-10-31", now)).toBe(true); expect(是逾期("2026-11-01", now)).toBe(false);
  expect(是逾期("2026-10-31T15:59:59Z", now)).toBe(true); expect(是逾期("2026-10-31T16:00:00Z", now)).toBe(false);
  const summary = 算提醒([
    { id: "old", kind: "plan", 标题: "旧日", customerId: "c", 客户: "QA", 时间: new Date("2026-10-30T16:00Z"), 日历日: "2026-10-31", 明确钟点: false },
    { id: "today", kind: "task", 标题: "今日", customerId: "c", 客户: "QA", 时间: new Date("2026-10-31T16:00Z"), 日历日: "2026-11-01", 明确钟点: false },
  ], now);
  expect(summary).toMatchObject({ 逾期: 1, 今天: 1, 最久: { 天: 1 }, 定时: [] });
  expect(定了时刻(new Date("2026-10-31T16:00Z"))).toBe(false);
  expect(定了时刻(new Date("2026-10-31T16:00Z"), true)).toBe(true);
  expect(smartTime("2026-10-31T16:15Z")).toBe("今天 00:15");
  expect(fmtDateTime("2026-11-01")).toBe("2026-11-01");
  expect(截止说法("2026-11-01")).toBe("今天"); expect(截止说法("2026-10-31")).toBe("逾期 1 天");
  expect(冷热("2026-10-31T15:59:59Z").天).toBe(1);
  expect(节点灯({ status: "未开始", dueAt: "2026-10-31" }, now)).toBe("红");
  expect(过期了("2026-10-31", now)).toBe(true); expect(过期了("2026-11-01", now)).toBe(false);
  expect(默认订单号([], now)).toBe("20261101-1");
});
it("数据库逾期计数与同日摘要一致，日期元数据和旧瞬间分别查", async () => {
  vi.useRealTimers(); vi.stubEnv("MULTI_TENANT", "0"); await resetDb();
  const u = await db.user.create({ data: { name: "QA", email: "business-clock", password: "qa" } });
  const c = await db.customer.create({ data: { name: "QA", phone: "", salesOwnerId: u.id } });
  await db.followPlan.create({ data: { customerId: c.id, ownerId: u.id, subject: "旧日", plannedAt: new Date("2026-10-30T16:00Z"), plannedOn: "2026-10-31" } });
  await db.task.create({ data: { customerId: c.id, ownerId: u.id, title: "今日", dueAt: new Date("2026-10-31T16:00Z"), dueOn: "2026-11-01" } });
  await db.task.create({ data: { customerId: c.id, ownerId: u.id, title: "旧瞬间", dueAt: new Date("2026-10-31T15:59:59Z") } });
  vi.stubEnv("MULTI_TENANT", "1"); expect(await 数逾期跟进(db, { ownerId: u.id }, now)).toBe(2);
});
it.each(["America/New_York", "America/Santiago", "Pacific/Auckland"])("桌面本地%s保留本机日期和DST边界，不被托管配置污染", tz => {
  vi.stubEnv("MULTI_TENANT", "0"); vi.stubEnv("TZ", tz);
  const local = new Date(2026, 8, 6, 12, 0);
  expect(dayjs(local).format("YYYY-MM-DD HH:mm")).toBe("2026-09-06 12:00");
  expect(calendarDay(local)).toBe("2026-09-06");
  expect(calendarDaysBetween("2026-09-05", "2026-09-06")).toBe(1);
  expect(截止说法("2026-09-05", dayjs(local))).toBe("逾期 1 天");
  expect(是逾期("2026-09-06", local)).toBe(false);
  if (tz === "America/Santiago") { expect(parseDateInput("2026-09-06")!.getHours()).toBe(1); expect(parseDateInput("2026-09-06T00:30")).toBeNull(); }
});

it("托管真实业务库的本月AI次数与复盘刻度在纽约宿主使用北京月界", async () => {
  vi.useRealTimers(); vi.stubEnv("MULTI_TENANT", "0"); await resetDb();
  const u = await db.user.create({ data: { name: "QA", email: "clock-month", password: "qa" } });
  const c = await db.customer.create({ data: { name: "QA", phone: "", salesOwnerId: u.id } });
  for (const [at, amount] of [["2026-10-31T15:50Z", 999], ["2026-10-31T16:10Z", 123]] as const) {
    await db.contract.create({ data: { customerId: c.id, amount, signedAt: new Date(at) } });
    await db.auditLog.create({ data: { userId: u.id, userName: u.name, action: "ai_use", entity: "Ai", entityId: "ask", summary: "QA", at: new Date(at) } });
  }
  vi.stubEnv("MULTI_TENANT", "1"); vi.stubEnv("WORKSPACE_DIR", path.resolve("prisma"));
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  await runWithTenant({ workspaceId: "clock-ws", slug: "clock-qa", dbFile: "test.db", role: "OWNER", writable: true }, async () => {
    expect((await aiUsageThisMonth(now)).find(x => x.feature === "ask")!.count).toBe(1);
    const month = await 加载复盘(dayjs(now).startOf("month").toDate(), dayjs(now).endOf("month").toDate(), "day");
    expect(month.total).toMatchObject({ amount: 123, count: 1 });
    expect(month.trend).toEqual([{ label: "11-01", amount: 123, count: 1 }]);
  });
});
