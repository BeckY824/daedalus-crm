/**
 * 逾期判定 改成「日历日每个串只验一次」以后，判出来必须和原来一模一样（2026-10-25，计划页分组企业版压测）。
 *
 * 原来的写法原样抄在下面当裁判。三种钟（本机、企业版北京、托管版北京）× 四个时区（北京、伦敦带夏令时、纽约、加尔各答半小时）
 * × 几个「现在」（北京零点前后、本机零点前后、夏令时那天）。同一个判定函数连着判全部串，串里有重复的，
 * 记住的结果是真是假都会被再用一次。串有：
 *   - 日历日：今天、昨天、明天、闰日、2026-02-30 / 2026-13-01 / 0000-00-00 这类验不过的
 *   - 10 个字符但不是日历日的：2026/10/25、2026-1-05、带空格的
 *   - 带 Z 的 ISO、不带 Z 的本地时刻、带 +08:00 的、解析不了的、空串、null、undefined、Date 对象
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { 逾期判定, 今天零点 } from "@/lib/overdue";
import { calendarDay, isCalendarDate } from "@/lib/schedule-date";

const originalTZ = process.env.TZ;
afterEach(() => { vi.unstubAllEnvs(); process.env.TZ = originalTZ; });

/** 改之前的 逾期判定，一字不改 */
function 原来的判定(now: Date = new Date()): (时间: Date | string | null | undefined) => boolean {
  let 今天: string | undefined, 零点: number | undefined;
  return (时间) => {
    if (!时间) return false;
    if (typeof 时间 === "string" && isCalendarDate(时间)) return 时间 < (今天 ??= calendarDay(now));
    const t = typeof 时间 === "string" ? new Date(时间) : 时间;
    return t.getTime() < (零点 ??= 今天零点(now).getTime());
  };
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

const 固定串 = [
  "2026-10-25", "2026-10-24", "2026-10-26", "2026-03-29", "2026-11-01", "2028-02-29", "1969-12-31", "9999-12-31",
  "2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026-10-00", "0000-00-00", "0050-01-01",
  "2026/10/25", "2026-1-05 ", " 2026-10-2", "2026-10-2a", "abcdefghij", "1234567890",
  "2026-10-24T15:59:59.999Z", "2026-10-24T16:00:00.000Z", "2026-10-25T00:00:00.000Z", "2026-10-24T23:59:59.999Z",
  "2026-10-25T08:00:00", "2026-10-25 08:00", "2026-10-25T08:00:00+08:00", "2026-10-25T08:00z", "不是时间", "",
];

function 随机串(种子: number, 个数: number): string[] {
  const r = 随机(种子);
  const out: string[] = [];
  for (let i = 0; i < 个数; i++) {
    const ms = Date.parse("2026-10-25T00:00:00Z") + Math.floor((r() - 0.6) * 60 * 86_400_000); // 前后两个月，日期重复得多
    const iso = new Date(ms).toISOString();
    const 种 = r();
    out.push(种 < 0.4 ? iso : 种 < 0.85 ? iso.slice(0, 10) : iso.slice(0, 19));
  }
  return out;
}

const 现在们 = [
  "2026-10-24T15:59:59.999Z", "2026-10-24T16:00:00.000Z", // 北京零点前后
  "2026-10-24T23:59:59.999Z", "2026-10-25T00:00:00.000Z", "2026-10-25T01:00:00.000Z", // 伦敦零点、夏令时结束那一刻
  "2026-10-25T04:59:59.999Z", "2026-10-25T05:00:00.000Z", // 纽约零点前后
  "2026-10-24T18:29:59.999Z", "2026-10-24T18:30:00.000Z", // 加尔各答零点前后
].map((s) => new Date(s));

describe.each([
  ["本机钟", {}],
  ["企业版北京钟", { CRM_ENTERPRISE: "1" }],
  ["托管版北京钟", { MULTI_TENANT: "1" }],
] as const)("逾期判定 和原来的写法对拍：%s", (_名, 开关) => {
  for (const tz of ["Asia/Shanghai", "Europe/London", "America/New_York", "Asia/Kolkata"]) {
    it(`TZ=${tz}`, () => {
      vi.stubEnv("TZ", tz);
      vi.stubEnv("MULTI_TENANT", "");
      vi.stubEnv("CRM_ENTERPRISE", "");
      for (const [k, v] of Object.entries(开关)) vi.stubEnv(k, v);
      const 串 = [...固定串, ...随机串(tz.length * 31 + Object.keys(开关).length, 2000), ...固定串];
      const 值: (Date | string | null | undefined)[] = [...串, null, undefined, ...串.slice(0, 200).map((s) => new Date(s))];
      for (const now of 现在们) {
        const 新 = 逾期判定(now), 旧 = 原来的判定(now);
        expect(值.map((v) => [v, 新(v)])).toEqual(值.map((v) => [v, 旧(v)]));
      }
    });
  }
});
