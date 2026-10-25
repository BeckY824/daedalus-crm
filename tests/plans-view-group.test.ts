/**
 * 计划页 PlansView 的分组改用 lib/plans-groups 的 分组（2026-10-25）：和页面原来那一段对拍。
 *
 * 旧分组 是 PlansView 改之前那一段原样抄下来的，当基准（now 固定传进去，两边看同一刻）。两边吃同一批数据：
 *   - 本机钟（北京、伦敦带夏令时、纽约、加尔各答半小时时区）和北京业务钟（企业版、托管版）
 *   - 只有日历日的、ISO 的、不带 Z 的本地时刻、没时间的、解析不了的
 *   - 正好落在今天零点、今天结束、本周结束上下一毫秒的；同一时刻好几条（看先后）
 *   - 周日、周一、跨月、跨年、夏令时那天
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { dayjs } from "@/lib/utils";
import { 是逾期 } from "@/lib/overdue";
import { 分组, 组名 } from "@/lib/plans-groups";

const originalTZ = process.env.TZ;
afterEach(() => { vi.unstubAllEnvs(); process.env.TZ = originalTZ; });

type 轻事项 = { key: string; 时间: string | null; ownerId: string };

/** 改之前 PlansView 里的那一段 */
function 旧分组(我的: 轻事项[], now: Date) {
  const 今天结束 = dayjs(now).endOf("day");
  const 本周结束 = dayjs(now).endOf("week");
  const out = { 逾期: [] as 轻事项[], 今天: [] as 轻事项[], 本周: [] as 轻事项[], 以后: [] as 轻事项[] };
  for (const x of 我的) {
    if (!x.时间) out.以后.push(x);
    else {
      const t = dayjs(x.时间);
      if (是逾期(x.时间, now)) out.逾期.push(x);
      else if (t.isBefore(今天结束)) out.今天.push(x);
      else if (t.isBefore(本周结束)) out.本周.push(x);
      else out.以后.push(x);
    }
  }
  for (const k of Object.keys(out) as (keyof typeof out)[]) {
    out[k].sort((a, c) => (a.时间 ? dayjs(a.时间).valueOf() : Infinity) - (c.时间 ? dayjs(c.时间).valueOf() : Infinity));
  }
  return out;
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

const 天 = 86_400_000;

function 造(种子: number, now: Date, 个数: number): 轻事项[] {
  const r = 随机(种子);
  const 挑 = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const 边 = [dayjs(now).startOf("day").valueOf(), dayjs(now).endOf("day").valueOf(), dayjs(now).endOf("week").valueOf()];
  const 本地串 = (ms: number) => { const d = new Date(ms); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`; };
  const 用过: string[] = [];
  const 行: 轻事项[] = [];
  for (let i = 0; i < 个数; i++) {
    const 种 = r();
    let 时间: string | null;
    const ms = r() < 0.3 ? 挑(边) + 挑([-1, 0, 1, -60_000, 60_000]) : now.getTime() + Math.floor((r() - 0.5) * 30 * 天);
    if (种 < 0.05) 时间 = null;
    else if (种 < 0.07) 时间 = 挑(["不是时间", "2026-13-01", "2026-02-30"]);
    else if (种 < 0.3) 时间 = dayjs(ms).format("YYYY-MM-DD");
    else if (种 < 0.4) 时间 = 本地串(ms);
    else if (种 < 0.5 && 用过.length) 时间 = 挑(用过); // 同一时刻好几条
    else 时间 = new Date(ms).toISOString();
    if (时间) 用过.push(时间);
    行.push({ key: `k${i}`, 时间, ownerId: r() < 0.5 ? "me" : "you" });
  }
  return 行;
}

const 时刻 = [
  new Date("2026-10-25T03:00:00Z"), // 伦敦夏令时结束那天、周日
  new Date("2026-10-25T16:30:00Z"), // 北京已是周一
  new Date("2026-10-24T15:59:59.999Z"), // 北京零点前一毫秒
  new Date("2026-03-29T00:30:00Z"), // 伦敦夏令时开始那天
  new Date("2026-12-31T23:55:00Z"), // 跨年
  new Date("2026-11-30T12:00:00Z"), // 跨月
];

describe.each([
  ["本机钟", {}],
  ["企业版北京钟", { CRM_ENTERPRISE: "1" }],
  ["托管版北京钟", { MULTI_TENANT: "1" }],
] as const)("计划页分组改用 分组：%s", (_名, 开关) => {
  for (const tz of ["Asia/Shanghai", "Europe/London", "America/New_York", "Asia/Kolkata"]) {
    it(`TZ=${tz} 每组的条目和先后都和原来一样`, () => {
      vi.stubEnv("TZ", tz);
      vi.stubEnv("MULTI_TENANT", "");
      vi.stubEnv("CRM_ENTERPRISE", "");
      for (const [k, v] of Object.entries(开关)) vi.stubEnv(k, v);
      时刻.forEach((now, i) => {
        const 行 = 造(i * 17 + tz.length, now, 800);
        const 旧 = 旧分组(行, now);
        const 新 = 分组(行, dayjs(now));
        for (const g of 组名) expect(新[g].map((x) => x.key), `${now.toISOString()} ${g}`).toEqual(旧[g].map((x) => x.key));
      });
    });
  }
});

it("空表、全是没时间的", () => {
  const now = 时刻[0];
  expect(分组([], dayjs(now))).toEqual(旧分组([], now));
  const 行 = [{ key: "a", 时间: null, ownerId: "me" }, { key: "b", 时间: null, ownerId: "me" }];
  expect(分组(行, dayjs(now))).toEqual(旧分组(行, now));
});
