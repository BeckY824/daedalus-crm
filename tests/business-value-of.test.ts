/**
 * businessValueOf 必须和 businessDayjs(串).valueOf() 一模一样（2026-10-25，计划页分组不再逐条建 Dayjs）。
 *
 * 三种钟（本机、企业版北京、托管版北京）× 四个时区（北京、伦敦带夏令时、纽约、加尔各答半小时）。串有：
 *   - 带 Z 的 ISO：随机瞬间、1970 年前、夏令时切换前后、北京零点前后一毫秒、小写 z、不带毫秒的
 *   - YYYY-MM-DD：夏令时那天、跨年、闰日、2026-02-30 / 2026-13-01 / 0000-00-00 这类、两位数年份
 *   - 走老路的：不带 Z 的本地时刻、带 +08:00 的、单位数月日、解析不了的、空串
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { businessDayjs, businessValueOf } from "@/lib/business-clock";

const originalTZ = process.env.TZ;
afterEach(() => { vi.unstubAllEnvs(); process.env.TZ = originalTZ; });

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
  "2026-10-25T00:59:59.999Z", "2026-10-25T01:00:00.000Z", "2026-03-29T01:00:00.000Z", "2026-11-01T06:00:00.000Z",
  "2026-10-24T15:59:59.999Z", "2026-10-24T16:00:00.000Z", "1969-12-31T23:59:59.999Z", "1900-01-01T00:00:00.000Z",
  "2026-10-25T08:00:00z", "2026-10-25T08:00:00Z", "2026-10-25T08:00Z", "不是时间Z", "2026-13-01T00:00:00Z",
  "2026-10-25", "2026-03-29", "2026-11-01", "2026-12-31", "2027-01-01", "2028-02-29", "2026-02-29",
  "2026-02-30", "2026-13-01", "2026-00-10", "2026-10-00", "0000-00-00", "0050-01-01", "1969-12-31", "9999-12-31",
  "2026-10-25T08:00:00", "2026-10-25 08:00", "2026-10-25T08:00:00.123", "2026-10-25T08:00:00+08:00", "2026-1-5",
  "2026/10/25", "20261025", "不是时间", "",
];

function 随机串(种子: number, 个数: number): string[] {
  const r = 随机(种子);
  const out: string[] = [];
  for (let i = 0; i < 个数; i++) {
    const ms = Math.floor((r() - 0.3) * 4e12); // 约 1931–2096 年
    const d = new Date(ms);
    const 种 = r();
    if (种 < 0.5) out.push(d.toISOString());
    else if (种 < 0.8) out.push(d.toISOString().slice(0, 10));
    else out.push(d.toISOString().slice(0, 19)); // 不带 Z 的本地时刻，走老路
  }
  return out;
}

describe.each([
  ["本机钟", {}],
  ["企业版北京钟", { CRM_ENTERPRISE: "1" }],
  ["托管版北京钟", { MULTI_TENANT: "1" }],
] as const)("businessValueOf 和 businessDayjs().valueOf() 对拍：%s", (_名, 开关) => {
  for (const tz of ["Asia/Shanghai", "Europe/London", "America/New_York", "Asia/Kolkata"]) {
    it(`TZ=${tz}`, () => {
      vi.stubEnv("TZ", tz);
      vi.stubEnv("MULTI_TENANT", "");
      vi.stubEnv("CRM_ENTERPRISE", "");
      for (const [k, v] of Object.entries(开关)) vi.stubEnv(k, v);
      const 串 = [...固定串, ...随机串(tz.length * 31 + Object.keys(开关).length, 3000)];
      // toEqual 把 NaN 当相等：解析不了的两边都得是 NaN
      expect(串.map((s) => [s, businessValueOf(s)])).toEqual(串.map((s) => [s, businessDayjs(s).valueOf()]));
    });
  }
});
