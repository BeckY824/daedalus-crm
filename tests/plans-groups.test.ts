/**
 * 计划页分组改成「每条只解析一次时间」（lib/plans-groups.ts 分组，2026-10-25 企业版压测）和原来的写法对拍：
 * 原来每条 dayjs 一次、是逾期() 每条重算今天零点、排序每比一次新建两个 dayjs。
 * 随机数据：只有日期的、带时间的 ISO、没定时间的、解析不了的、同一时刻一大片、今天 / 本周边界；
 * 本机时钟和北京业务钟（MULTI_TENANT=1）各跑一遍。分出来的组、每组的先后（含同一时刻按传进来的先后）都要一模一样。
 */
import { describe, it, expect, afterEach } from "vitest";
import { dayjs } from "@/lib/utils";
import { 是逾期 } from "@/lib/overdue";
import { 组名, 分组, type 组 } from "@/lib/plans-groups";

/** 改之前的分组，一字不改留在这里当对照 */
function 原来的分组<T extends { 时间: string | null }>(行: readonly T[], now = dayjs()): Record<组, T[]> {
  const 今天结束 = now.endOf("day");
  const 本周结束 = now.endOf("week");
  const out: Record<组, T[]> = { 逾期: [], 今天: [], 本周: [], 以后: [] };
  for (const x of 行) {
    if (!x.时间) out.以后.push(x);
    else {
      const t = dayjs(x.时间);
      if (是逾期(x.时间, now.toDate())) out.逾期.push(x);
      else if (t.isBefore(今天结束)) out.今天.push(x);
      else if (t.isBefore(本周结束)) out.本周.push(x);
      else out.以后.push(x);
    }
  }
  for (const k of 组名) out[k].sort((a, c) => (a.时间 ? dayjs(a.时间).valueOf() : Infinity) - (c.时间 ? dayjs(c.时间).valueOf() : Infinity));
  return out;
}

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

function 造行(r: () => number, now: ReturnType<typeof dayjs>, n: number) {
  const 同一刻 = now.add(Math.floor(r() * 72) - 24, "hour").toISOString();
  const 边界 = [now.startOf("day"), now.endOf("day"), now.endOf("week"), now.endOf("day").add(1, "millisecond"), now.endOf("week").add(1, "millisecond")];
  return Array.from({ length: n }, (_, i) => {
    const 抽 = r();
    let 时间: string | null;
    if (抽 < 0.1) 时间 = null;
    else if (抽 < 0.12) 时间 = "不是时间";
    else if (抽 < 0.3) 时间 = 同一刻;
    else if (抽 < 0.4) 时间 = 边界[Math.floor(r() * 边界.length)].toISOString();
    else {
      const d = now.add(Math.floor(r() * 60 * 24 * 60) - 60 * 24 * 30, "minute");
      时间 = r() < 0.35 ? d.format("YYYY-MM-DD") : d.toISOString();
    }
    return { key: `plan:${i}`, 时间, ownerId: `u${i % 3}` };
  });
}

const 原 = process.env.MULTI_TENANT;
afterEach(() => {
  if (原 === undefined) delete process.env.MULTI_TENANT;
  else process.env.MULTI_TENANT = 原;
});

describe("分组：每条只解析一次，和原来的写法分得一模一样", () => {
  for (const 钟 of ["本机", "北京业务钟"] as const) {
    it(钟, () => {
      if (钟 === "北京业务钟") process.env.MULTI_TENANT = "1";
      else delete process.env.MULTI_TENANT;
      for (let 种子 = 1; 种子 <= 40; 种子++) {
        const r = 随机(种子);
        // 今天是周日（本周只剩今天）、周一、普通一天、快到半夜都要有
        const now = dayjs().startOf("week").add(Math.floor(r() * 7), "day").add(Math.floor(r() * 24 * 60), "minute");
        const 行 = 造行(r, now, 50 + Math.floor(r() * 400));
        const 新 = 分组(行, now);
        const 旧 = 原来的分组(行, now);
        for (const k of 组名) expect(新[k].map((x) => x.key), `${钟} 种子 ${种子} ${k}`).toEqual(旧[k].map((x) => x.key));
      }
    });
  }
});
