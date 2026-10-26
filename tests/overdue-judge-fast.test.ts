/**
 * 逾期判定 改成「日历日每个串只验一次」以后，判出来必须和原来一模一样（2026-10-25，计划页分组企业版压测）。
 *
 * 原来的写法原样抄在下面当裁判。三种钟（本机、企业版北京、托管版北京）× 四个时区（北京、伦敦带夏令时、纽约、加尔各答半小时）
 * × 几个「现在」（北京零点前后、本机零点前后、夏令时那天）。同一个判定函数连着判全部串，串里有重复的，
 * 记住的结果是真是假都会被再用一次。串有：
 *   - 日历日：今天、昨天、明天、闰日、2026-02-30 / 2026-13-01 / 0000-00-00 这类验不过的
 *   - 10 个字符但不是日历日的：2026/10/25、2026-1-05、带空格的
 *   - 带 Z 的 ISO、不带 Z 的本地时刻、带 +08:00 的、解析不了的、空串、null、undefined、Date 对象
 *
 * 对拍只能说明「和原来一样」。最后一组写死答案钉边界（2026-10-26）：刚好在今天零点不算逾期、早 1 ms 算；
 * 「现在」跨过零点那 1 ms，昨天的事项才变成逾期。逾期条件() 给库用的两条界线也得落在同一个点上。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { 逾期判定, 今天零点, 是逾期, 逾期条件 } from "@/lib/overdue";
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

/** 同一个 now 下，单判（是逾期）和一个判定函数连着判（逾期判定，带记忆）都要给出同一个答案 */
function 都判(值们: (Date | string)[], now: Date): boolean[] {
  const 判 = 逾期判定(now);
  const 连着 = [...值们, ...值们].map(判); // 判两遍：第二遍走记住的日历日和零点
  const 单个 = 值们.map((v) => 是逾期(v, now));
  expect(连着).toEqual([...单个, ...单个]);
  return 单个;
}

describe.each([
  // 企业版按北京钟：10-26 的北京零点是 2026-10-25T16:00:00.000Z。机器放在伦敦，免得和本机钟碰巧一样
  ["企业版北京钟", { CRM_ENTERPRISE: "1" }, "2026-10-26T03:00:00.000Z", "2026-10-25T16:00:00.000Z", "2026-10-26", "2026-10-25"],
  // 本机钟、伦敦：10-25 夏令时结束，10-26 的本地零点是 2026-10-26T00:00:00.000Z
  ["本机钟（伦敦）", {}, "2026-10-26T10:00:00.000Z", "2026-10-26T00:00:00.000Z", "2026-10-26", "2026-10-25"],
] as const)("边界：刚好到期 / 差 1 ms（%s）", (_名, 开关, 现在串, 零点串, 今天, 昨天) => {
  const 零点 = Date.parse(零点串);
  const 早1ms = new Date(零点 - 1).toISOString();
  const 设钟 = () => {
    vi.stubEnv("TZ", "Europe/London");
    vi.stubEnv("MULTI_TENANT", "");
    vi.stubEnv("CRM_ENTERPRISE", "");
    for (const [k, v] of Object.entries(开关)) vi.stubEnv(k, v);
  };

  it("事项时间：刚好在今天零点不算逾期，早 1 ms 算；串和 Date 一样", () => {
    设钟();
    const now = new Date(现在串);
    expect(今天零点(now).getTime()).toBe(零点);
    expect(都判([零点串, new Date(零点), 早1ms, new Date(零点 - 1)], now)).toEqual([false, false, true, true]);
  });

  it("只有日期的事项：今天的不算逾期，昨天的算", () => {
    设钟();
    expect(都判([今天, 昨天], new Date(现在串))).toEqual([false, true]);
  });

  it("「现在」跨过零点那 1 ms：昨天的事项（日期或钟点）从不逾期变成逾期", () => {
    设钟();
    const 昨天下午 = new Date(零点 - 8 * 3_600_000).toISOString();
    expect(都判([昨天, 昨天下午], new Date(零点 - 1))).toEqual([false, false]);
    expect(都判([昨天, 昨天下午], new Date(零点))).toEqual([true, true]);
  });

  it("逾期条件() 给库的界线和判定落在同一个点：plannedAt / dueAt < 零点，plannedOn / dueOn < 今天", () => {
    设钟();
    const w = 逾期条件({}, new Date(现在串));
    expect([w.plan.OR[0].plannedOn?.lt, w.task.OR[0].dueOn?.lt]).toEqual([今天, 今天]);
    expect([w.plan.OR[1].plannedAt?.lt.getTime(), w.task.OR[1].dueAt?.lt.getTime()]).toEqual([零点, 零点]);
  });
});
