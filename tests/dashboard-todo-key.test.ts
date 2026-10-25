/**
 * 首页待办的排序键 + 只留前几名（lib/dashboard-todo.ts 排序键 / 前几名，2026-10-25 企业版压测）
 * 和原来「每行 scheduleValue 出串、按先后排 全排再截」对拍：取出来的条目和先后一模一样。
 * 随机数据：只排日期的（合法 / 2 月 30 日 / 「下周」/ 空串）、带钟点的、年份 0 / 10000 / 公元前、同一天一大片、同一毫秒一大片、没排时间的；
 * id 有大写、连字符、下划线；三个时区 × 本机钟 / 北京业务钟（MULTI_TENANT=1）
 */
import { describe, it, expect, afterAll } from "vitest";
import { scheduleValue } from "@/lib/schedule-date";
import { 按先后排, 排序键, 前几名 } from "@/lib/dashboard-todo";

const 原 = { TZ: process.env.TZ, MT: process.env.MULTI_TENANT };
afterAll(() => {
  process.env.TZ = 原.TZ;
  if (原.MT === undefined) delete process.env.MULTI_TENANT;
  else process.env.MULTI_TENANT = 原.MT;
});

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
const 起 = Date.parse("2026-10-20T00:00:00Z");
const 怪年 = (y: number) => {
  const d = new Date(起);
  d.setUTCFullYear(y);
  return d;
};

function 造行(r: () => number, n: number) {
  const 同一刻 = new Date(起 + Math.floor(r() * 5) * 天 + 9 * 3600_000);
  const 时刻 = () => {
    const 抽 = r();
    if (抽 < 0.25) return new Date(同一刻);
    if (抽 < 0.3) return 怪年([0, 10000, -5, 1, 9999][Math.floor(r() * 5)]);
    return new Date(起 + Math.floor(r() * 8 * 天) - 2 * 天);
  };
  const 日期 = () => {
    const 抽 = r();
    if (抽 < 0.08) return ["2026-02-30", "下周", "", "2026-10-2", "0000-01-01"][Math.floor(r() * 5)];
    return `2026-10-${String(18 + Math.floor(r() * 8)).padStart(2, "0")}`;
  };
  return Array.from({ length: n }, (_, i) => {
    const 是任务 = r() < 0.4;
    const 型 = r();
    const at = 是任务 && 型 < 0.15 ? null : 时刻();
    const on = 型 < 0.5 ? 日期() : null;
    const 号 = [`x${i}`, `X-${i}`, `x_${i}`, `c${i}`][i % 4];
    return { id: `${是任务 ? "task" : "plan"}:${号}`, at, on };
  });
}

describe("首页待办排序键 + 前几名：和每行出串、全排再截一模一样", () => {
  for (const tz of ["Asia/Shanghai", "Europe/London", "America/New_York"]) {
    for (const 钟 of ["本机", "北京业务钟"] as const) {
      it(`${tz} · ${钟}`, () => {
        process.env.TZ = tz;
        if (钟 === "北京业务钟") process.env.MULTI_TENANT = "1";
        else delete process.env.MULTI_TENANT;
        for (let 种子 = 1; 种子 <= 30; 种子++) {
          const r = 随机(种子);
          const 行 = 造行(r, 30 + Math.floor(r() * 600));
          const 原来 = 按先后排(行.map((x) => ({ id: x.id, dueAt: scheduleValue(x.at, x.on) })));
          const 键 = 排序键();
          const 带键 = 行.map((x) => ({ id: x.id, k: 键(x.at, x.on) }));
          for (const n of [0, 1, 5, 20, 行.length]) {
            expect(前几名(带键, n).map((x) => x.id), `${tz} ${钟} 种子 ${种子} 取 ${n}`).toEqual(原来.slice(0, n).map((x) => x.id));
          }
        }
      });
    }
  }
});
