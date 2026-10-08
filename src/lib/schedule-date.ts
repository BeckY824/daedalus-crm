import { businessDayjs } from "./business-clock";
import { parseDateInput } from "./date-input";

/** 仅日期保留原日历日；hasTime为空表示旧数据未记录选择方式，不能反推。 */
export type ScheduleDate = { at: Date | null; on: string | null; hasTime: boolean | null };
export const isCalendarDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && parseDateInput(value) !== null;

export function parseScheduleDate(value: string | null | undefined, previous?: ScheduleDate, explicitHasTime?: boolean): ScheduleDate | null {
  if (!value) return { at: null, on: null, hasTime: null };
  if (explicitHasTime !== undefined && typeof explicitHasTime !== "boolean") return null;
  const s = value.trim(); const at = parseDateInput(s);
  if (!at) return null;
  if (isCalendarDate(s)) return explicitHasTime === true ? null : { at, on: s, hasTime: false };
  if (explicitHasTime === false) return null; // 日期模式必须交回日历日，不能从ISO截取猜测
  // 老客户端交回未变的ISO：不得把新版本保存的日期语义变成定时提醒。
  if (explicitHasTime === undefined && previous?.at?.getTime() === at.getTime()) return { ...previous };
  return { at, on: null, hasTime: true };
}

export function scheduleValue(at: Date | null | undefined, on: string | null | undefined): string | null {
  return on && isCalendarDate(on) ? on : at?.toISOString() ?? null;
}

export function calendarDay(d: Date): string {
  return businessDayjs(d).format("YYYY-MM-DD");
}

/** 日历日差不除本地毫秒，DST的23/25小时仍各算一天。 */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);
}

/** 服务端/本地按原日历日排序；空时间放最后，不用混合ISO和日期串的字典序。 */
export function scheduleOrder(at: Date | string | null | undefined, on?: string | null): number {
  const value = on ?? at;
  if (!value) return Infinity;
  return value instanceof Date ? value.getTime() : parseDateInput(value)?.getTime() ?? Infinity;
}

export function earliestScheduled<T>(rows: readonly T[], value: (row: T) => number, limit = rows.length): T[] {
  return [...rows].sort((a, b) => value(a) - value(b)).slice(0, limit);
}

/** 预计签约只选日期。兼容老客户端Date/ISO，未变时保留原日历日，不从时区猜历史意图。 */
export function parseSignDate(value: unknown, previous?: { expectedSignAt: Date | null; expectedSignOn: string | null }): { at: Date | null; on: string | null } | null {
  if (value == null || value === "") return { at: null, on: null };
  if (typeof value === "string") value = value.trim();
  const at = value instanceof Date ? value : parseDateInput(value);
  if (!at || !Number.isFinite(at.getTime())) return null;
  if (typeof value === "string" && isCalendarDate(value)) return { at, on: value };
  return { at, on: previous?.expectedSignAt?.getTime() === at.getTime() ? previous.expectedSignOn : null };
}
