/**
 * businessDay 必须和 businessDayjs(串).format("YYYY-MM-DD") 一模一样；订单节点灯、超期数改用它以后，
 * 必须和原来逐个建 Dayjs 的写法一模一样（2026-10-25，订单列表不再逐个节点建 Dayjs）。
 *
 * 三种钟（本机、企业版北京、托管版北京）× 四个时区（北京、伦敦带夏令时、纽约、加尔各答半小时）。串有：
 *   - 带 Z 的 ISO：随机瞬间、1970 年前、夏令时切换前后、北京零点前后一毫秒、小写 z、不带毫秒的、年份两头
 *   - 走老路的：YYYY-MM-DD、不带 Z 的本地时刻、带 +08:00 的、单位数月日、解析不了的、空串
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { businessDay, businessDayjs } from "@/lib/business-clock";
import { calendarDay, calendarDaysBetween } from "@/lib/schedule-date";
import { 节点灯, 超期数, type 节点 } from "@/lib/order";

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
  "2026-10-25T08:00:00z", "2026-10-25T08:00:00Z", "2026-10-25T08:00Z", "不是时间Z", "2026-13-01T00:00:00Z", "Z",
  "0000-01-01T00:00:00.000Z", "0001-01-01T00:00:00.000Z", "9999-12-31T15:59:59.999Z", "9999-12-31T16:00:00.000Z",
  "+010000-01-01T00:00:00.000Z", "-000001-12-31T20:00:00.000Z",
  "2026-10-25", "2026-03-29", "2028-02-29", "2026-02-30", "2026-13-01", "0000-00-00", "9999-12-31",
  "2026-10-25T08:00:00", "2026-10-25 08:00", "2026-10-25T08:00:00.123", "2026-10-25T08:00:00+08:00", "2026-1-5",
  "2026/10/25", "20261025", "不是时间", "",
];

function 随机串(种子: number, 个数: number): string[] {
  const r = 随机(种子);
  const out: string[] = [];
  for (let i = 0; i < 个数; i++) {
    const d = new Date(Math.floor((r() - 0.3) * 4e12)); // 约 1931–2096 年
    const 种 = r();
    if (种 < 0.8) out.push(d.toISOString());
    else if (种 < 0.9) out.push(d.toISOString().slice(0, 10));
    else out.push(d.toISOString().slice(0, 19)); // 不带 Z 的本地时刻，走老路
  }
  return out;
}

/** 改之前的节点灯，原样抄来当裁判 */
function 老节点灯(n: Pick<节点, "status" | "dueAt">, 现在: Date): string {
  if (n.status === "已完成") return "绿";
  if (n.status === "不适用") return "灰";
  if (n.status === "卡住") return "红";
  if (!n.dueAt) return "无";
  const 差天 = calendarDaysBetween(calendarDay(现在), businessDayjs(n.dueAt).format("YYYY-MM-DD"));
  if (差天 < 0) return "红";
  if (差天 <= 3) return "黄";
  return "无";
}

const 状态们 = ["未开始", "进行中", "已完成", "不适用", "卡住"];

describe.each([
  ["本机钟", {}],
  ["企业版北京钟", { CRM_ENTERPRISE: "1" }],
  ["托管版北京钟", { MULTI_TENANT: "1" }],
] as const)("businessDay 和节点灯对拍：%s", (_名, 开关) => {
  for (const tz of ["Asia/Shanghai", "Europe/London", "America/New_York", "Asia/Kolkata"]) {
    const 换钟 = () => {
      vi.stubEnv("TZ", tz);
      vi.stubEnv("MULTI_TENANT", "");
      vi.stubEnv("CRM_ENTERPRISE", "");
      for (const [k, v] of Object.entries(开关)) vi.stubEnv(k, v);
    };

    it(`TZ=${tz} businessDay 和 businessDayjs().format() 一样`, () => {
      换钟();
      const 串 = [...固定串, ...随机串(tz.length * 31 + Object.keys(开关).length, 3000)];
      expect(串.map((s) => [s, businessDay(s)])).toEqual(串.map((s) => [s, businessDayjs(s).format("YYYY-MM-DD")]));
    });

    it(`TZ=${tz} 节点灯、超期数和原来一样（今天的零点前后、夏令时那几天）`, () => {
      换钟();
      const r = 随机(tz.length * 17 + Object.keys(开关).length);
      const 此刻们 = [
        "2026-10-24T15:59:59.999Z", "2026-10-24T16:00:00.000Z", "2026-10-25T00:30:00.000Z", "2026-10-25T23:59:59.999Z",
        "2026-03-29T00:30:00.000Z", "2026-11-01T05:30:00.000Z", "2026-12-31T16:00:00.000Z", "2026-10-25T18:29:59.999Z",
      ].map((s) => new Date(s));
      const 基准 = Date.parse("2026-10-25T00:00:00Z");
      for (const 现在 of 此刻们) {
        const 单们: Pick<节点, "status" | "dueAt">[][] = [];
        for (let i = 0; i < 40; i++) {
          const 节点们: Pick<节点, "status" | "dueAt">[] = [];
          for (let j = 0; j < 12; j++) {
            const 种 = r();
            // 截止日落在前后十来天，零点前后一小时的特别多
            const ms = 基准 + Math.floor((r() - 0.5) * 20) * 86_400_000 + (r() < 0.5 ? Math.floor((r() - 0.5) * 7_200_000) : Math.floor(r() * 86_400_000));
            const dueAt = 种 < 0.1 ? null : 种 < 0.15 ? new Date(ms).toISOString().slice(0, 10) : new Date(ms).toISOString();
            节点们.push({ status: 状态们[Math.floor(r() * 状态们.length)], dueAt });
          }
          单们.push(节点们);
        }
        const 全部 = 单们.flat();
        expect(全部.map((n) => 节点灯(n, 现在))).toEqual(全部.map((n) => 老节点灯(n, 现在)));
        expect(单们.map((ns) => 超期数(ns, 现在))).toEqual(单们.map((ns) => ns.filter((n) => 老节点灯(n, 现在) === "红").length));
      }
    });
  }
});
