/**
 * 企业版业务时区（F3，2026-10-25 实测）：人在伦敦打开企业版网页，时间、「今天」都要按北京，
 * 和服务器上的夜扫（00:05）、到期判断同一条日界线。
 *
 * 毛病出在开关：北京业务钟只给托管版（MULTI_TENANT）开，企业版落回浏览器本地时区，
 * 服务器又按 TZ=Asia/Shanghai 渲染——同一条沟通记录页头 09:19、列表 01:19，刷新前后还会变。
 *
 * 这里把主机钟拨到伦敦，钉住：企业版开 → 北京；开关全关（个人版、团队版、开源自部署）→ 还是本机，不动。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nativeDayjs from "dayjs";
import { businessTimeZone } from "@/lib/business-clock";
import { dayjs, fmtDateTime, smartTime } from "@/lib/utils";
import { parseDateInput } from "@/lib/date-input";
import { 过了夜扫时刻 } from "@/lib/project/nightly";

const originalTZ = process.env.TZ;
// 伦敦 10-25 16:30（当天凌晨已切回 GMT）= 北京 10-26 00:30：两边已经不是同一天
const now = new Date("2026-10-25T16:30:00Z");

beforeEach(() => {
  vi.stubEnv("TZ", "Europe/London");
  vi.stubEnv("MULTI_TENANT", "");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); process.env.TZ = originalTZ; });

describe("企业版开：主机在伦敦也按北京", () => {
  beforeEach(() => { vi.stubEnv("CRM_ENTERPRISE", "1"); });

  it("业务时区是北京，页面的 BusinessProvider 拿到的也是它", () => {
    expect(businessTimeZone()).toBe("Asia/Shanghai");
    // 布局把服务端这一个判断原样发给浏览器：两边同一条日界线，不会再各算各的
    const layout = readFileSync(path.resolve(__dirname, "../src/app/(app)/layout.tsx"), "utf8");
    expect(layout).toMatch(/<BusinessProvider[^\n]*timeZone=\{businessTimeZone\(\)\}/);
  });

  it("显示的时间和北京一致（D7 P14：页头 09:19，沟通记录也要 09:19）", () => {
    expect(fmtDateTime(new Date("2026-10-21T01:19:00Z"))).toBe("2026-10-21 09:19");
    expect(dayjs().format("YYYY-MM-DD HH:mm")).toBe("2026-10-26 00:30");
    expect(nativeDayjs().format("YYYY-MM-DD HH:mm")).toBe("2026-10-25 16:30");
  });

  it("「今天」按北京划：北京已过零点的记录算今天", () => {
    expect(smartTime("2026-10-25T16:10:00Z")).toBe("今天 00:10");
    expect(dayjs().isSame("2026-10-26", "day")).toBe(true);
  });

  it("填的沟通时间按北京墙钟存（D2：伦敦填 08:00 不再存偏）", () => {
    expect(parseDateInput("2026-10-26T08:00")!.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(parseDateInput("2026-10-26")!.toISOString()).toBe("2026-10-25T16:00:00.000Z");
  });

  it("夜扫 00:05 按北京：北京 00:04 还没到，00:05 到了", () => {
    expect(过了夜扫时刻(new Date("2026-10-25T16:04:00Z"))).toBe(false);
    expect(过了夜扫时刻(new Date("2026-10-25T16:05:00Z"))).toBe(true);
  });
});

describe("开关全关：个人版、团队版、开源自部署照旧按本机", () => {
  it("业务时区不设，时间和「今天」跟着主机钟", () => {
    expect(businessTimeZone()).toBeNull();
    expect(dayjs().format("YYYY-MM-DD HH:mm")).toBe("2026-10-25 16:30");
    expect(fmtDateTime(new Date("2026-10-21T01:19:00Z"))).toBe("2026-10-21 02:19");
    expect(parseDateInput("2026-10-26T08:00")!.toISOString()).toBe("2026-10-26T08:00:00.000Z");
    expect(过了夜扫时刻(new Date("2026-10-25T16:04:00Z"))).toBe(true);
  });

  it("托管版不受影响：仍是北京", () => {
    vi.stubEnv("MULTI_TENANT", "1");
    expect(businessTimeZone()).toBe("Asia/Shanghai");
  });
});
