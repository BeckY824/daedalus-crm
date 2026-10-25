/**
 * 算提醒 不再逐条建 Dayjs（lib/reminders.ts，2026-10-25）：和原来逐条走 businessDayjs / calendarDay 的写法对拍。
 *
 * 旧算提醒 是改之前那一段原样抄下来的，当基准。两边吃同一批数据：
 *   - 本机钟（北京、伦敦带夏令时、纽约、加尔各答半小时时区）和北京业务钟（企业版、托管版）
 *   - 正好落在本机零点、北京零点、差一分钟的时刻；只有日历日的；明确钟点 true / false / 没填
 *   - 无效的 Date、没有时间的
 *   - 回看窗口边上（now - 10 分钟、now + 1 天）；前后 40 天，跨月、跨年
 *   - 整批算一次，再一条一条单算（最久 只看最早那一条，单算才对得上每一条的日历日）
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { businessDayjs } from "@/lib/business-clock";
import { calendarDay, calendarDaysBetween } from "@/lib/schedule-date";
import { 算提醒, 定了时刻, type 提醒项 } from "@/lib/reminders";

const originalTZ = process.env.TZ;
afterEach(() => { vi.unstubAllEnvs(); process.env.TZ = originalTZ; });

const 天 = 86_400_000;

function 旧定了时刻(t: Date, 明确钟点?: boolean | null): boolean {
  const local = businessDayjs(t);
  return 明确钟点 ?? (local.hour() !== 0 || local.minute() !== 0);
}

/** 改之前的 算提醒（不含订单那段，订单没动） */
function 旧算提醒(项: 提醒项[], now: Date) {
  const 今天开始 = businessDayjs(now).startOf("day").toDate();
  const 明天开始 = businessDayjs(now).add(1, "day").startOf("day").toDate();
  const 今天串 = calendarDay(now);
  let 逾期 = 0;
  let 今天 = 0;
  let 最早逾期: 提醒项 | null = null;
  const 定时: { key: string; at: string }[] = [];
  const 错过: { key: string; at: string }[] = [];
  for (const x of 项) {
    if (!x.时间) continue;
    const t = x.时间;
    if (x.日历日 ? x.日历日 < 今天串 : t < 今天开始) {
      逾期++;
      if (!最早逾期 || (x.日历日 ?? calendarDay(t)) < (最早逾期.日历日 ?? calendarDay(最早逾期.时间!))) 最早逾期 = x;
    } else if (x.日历日 ? x.日历日 === 今天串 : t < 明天开始) {
      今天++;
    }
    const 一项 = () => ({ key: `${x.kind}:${x.id}`, at: t.toISOString() });
    if (!x.日历日 && 旧定了时刻(t, x.明确钟点) && t.getTime() >= now.getTime() - 10 * 60_000 && t.getTime() < now.getTime() + 天) {
      定时.push(一项());
    } else if (!x.日历日 && 旧定了时刻(t, x.明确钟点) && t.getTime() < now.getTime() - 10 * 60_000 && t.getTime() >= now.getTime() - 天) {
      错过.push(一项());
    }
  }
  定时.sort((a, b) => a.at.localeCompare(b.at));
  错过.sort((a, b) => a.at.localeCompare(b.at));
  const 最久 = 最早逾期
    ? { 客户: 最早逾期.客户, 天: calendarDaysBetween(最早逾期.日历日 ?? calendarDay(最早逾期.时间!), 今天串) }
    : null;
  return { 逾期, 今天, 定时, 错过, 最久 };
}

/** 固定种子的伪随机数：失败时能原样复现 */
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

function 造(种子: number, now: Date, 个数: number): 提醒项[] {
  const r = 随机(种子);
  const 挑 = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const 本机零点 = new Date(now); 本机零点.setHours(0, 0, 0, 0);
  const 北京零点 = Math.floor((now.getTime() + 8 * 3_600_000) / 天) * 天 - 8 * 3_600_000;
  const 项: 提醒项[] = [];
  for (let i = 0; i < 个数; i++) {
    const 偏天 = Math.floor(r() * 21) - 10;
    const 种 = r();
    let ms: number;
    if (种 < 0.2) ms = 本机零点.getTime() + 偏天 * 天;
    else if (种 < 0.4) ms = 北京零点 + 偏天 * 天;
    else if (种 < 0.45) ms = 北京零点 + 偏天 * 天 + 挑([-60_000, 60_000, 30_000, -1]);
    else if (种 < 0.55) ms = now.getTime() + 挑([-天, -天 - 1, -10 * 60_000, -10 * 60_000 - 1, 0, 天 - 1, 天]);
    else ms = now.getTime() + Math.floor((r() - 0.5) * 80 * 天);
    const 时间 = r() < 0.03 ? new Date(Number.NaN) : r() < 0.03 ? null : new Date(ms);
    const 日历日 = r() < 0.2 && 时间 && !Number.isNaN(时间.getTime()) ? calendarDay(new Date(ms + 偏天 * 天)) : null;
    项.push({ id: `x${i}`, kind: r() < 0.5 ? "plan" : "task", 标题: `t${i}`, 时间, 日历日, 明确钟点: 挑([true, false, null, undefined]), customerId: "c", 客户: `客户${i}` });
  }
  return 项;
}

function 对拍(项: 提醒项[], now: Date) {
  const 新 = 算提醒(项, now);
  const 旧 = 旧算提醒(项, now);
  expect({ 逾期: 新.逾期, 今天: 新.今天, 最久: 新.最久 }).toEqual({ 逾期: 旧.逾期, 今天: 旧.今天, 最久: 旧.最久 });
  expect(新.定时.map(({ key, at }) => ({ key, at }))).toEqual(旧.定时);
  expect(新.错过.map(({ key, at }) => ({ key, at }))).toEqual(旧.错过);
  for (const x of 项) if (x.时间) expect(定了时刻(x.时间, x.明确钟点), `${x.id} ${x.时间.getTime()}`).toBe(旧定了时刻(x.时间, x.明确钟点));
}

const 时刻 = [
  new Date("2026-10-25T03:00:00Z"), // 伦敦夏令时结束那天
  new Date("2026-10-24T16:00:00Z"), // 北京零点
  new Date("2026-03-29T00:30:00Z"), // 伦敦夏令时开始那天
  new Date("2026-12-31T23:55:00Z"), // 跨年
];

describe.each([
  ["本机钟", {}],
  ["企业版北京钟", { CRM_ENTERPRISE: "1" }],
  ["托管版北京钟", { MULTI_TENANT: "1" }],
] as const)("算提醒不逐条建 Dayjs：%s", (_名, 开关) => {
  for (const tz of ["Asia/Shanghai", "Europe/London", "America/New_York", "Asia/Kolkata"]) {
    it(`TZ=${tz} 和原来逐条走 Dayjs 的结果一样`, () => {
      vi.stubEnv("TZ", tz);
      vi.stubEnv("MULTI_TENANT", "");
      vi.stubEnv("CRM_ENTERPRISE", "");
      for (const [k, v] of Object.entries(开关)) vi.stubEnv(k, v);
      时刻.forEach((now, i) => {
        const 项 = 造(i * 31 + tz.length, now, 600);
        对拍(项, now);
        // 一条一条单算：最久 只看最早那一条，单算才能把每一条的日历日都对上
        for (const x of 项) 对拍([x], now);
      });
    });
  }
});

it("空表、全是没时间的", () => {
  const now = 时刻[0];
  对拍([], now);
  对拍([{ id: "a", kind: "plan", 标题: "", 时间: null, customerId: "c", 客户: "" }], now);
});

it.each([["本机钟", ""], ["北京钟", "1"]])("1970 年以前、四位以下的年份（%s）", (_名, 企业) => {
  vi.stubEnv("TZ", "America/New_York");
  vi.stubEnv("MULTI_TENANT", "");
  vi.stubEnv("CRM_ENTERPRISE", 企业);
  const now = 时刻[0];
  const 老 = ["1969-12-31T16:00:00Z", "1969-12-31T16:01:00Z", "1969-12-31T05:00:00Z", "1900-03-01T00:00:00Z", "0050-07-01T16:00:00Z", "0999-12-31T23:59:00Z"];
  for (const [i, s] of 老.entries()) {
    const x: 提醒项 = { id: `o${i}`, kind: "plan", 标题: "", 时间: new Date(s), customerId: "c", 客户: s };
    对拍([x], now);
  }
});
