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
  return `${String(d.getFullYear()).padStart(4, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 日历日差不除本地毫秒，DST的23/25小时仍各算一天。 */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);
}
