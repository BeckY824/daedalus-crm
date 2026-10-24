import { dayjs } from "@/lib/utils";
import { 是逾期 } from "@/lib/overdue";

/**
 * 跟进计划页的「每组摆几条」（页面和服务端都用，不碰库；取数在 lib/plans-page.ts）。
 */

export const 每批 = 50;

/** 页面上四组的先后，URL 里 n= 的顺序也是它 */
export const 组名 = ["逾期", "今天", "本周", "以后"] as const;
export type 组 = (typeof 组名)[number];

/** URL 里的 n=50,100,50,50 → 每组取几条；缺的、不合法的、小于一批的都按一批 */
export function 读每组(n: string | undefined | null): number[] {
  const 段 = (n ?? "").split(",");
  return 组名.map((_, i) => {
    const v = Number(段[i]);
    return Number.isSafeInteger(v) && v > 每批 ? v : 每批;
  });
}

export function 写每组(每组: readonly number[]): string {
  return 组名.map((_, i) => 每组[i] ?? 每批).join(",");
}

/**
 * 服务端预先挑「每组前 N 条」用的分组。和 PlansView 里那一段同一个算法、同一个排序（稳定排序，
 * 同一时刻按传进来的先后）；页面上仍以 PlansView 自己分的为准——浏览器和服务器时区不同时
 * 两边分出来会差几条，差的那几条页面再去取（plan-rows.ts）。tests/plans-page.test.ts 拿两边对拍。
 */
export function 分组<T extends { 时间: string | null }>(行: readonly T[], now = dayjs()): Record<组, T[]> {
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
