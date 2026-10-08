/** 严格接收日历日期或ISO/本地日期时间，拒绝Date的自动顺延和含糊格式。 */
export function parseDateInput(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value.trim());
  if (!match) return null;
  const [, ys, ms, ds, hs, mins, ss, fraction, zone] = match;
  const y = Number(ys), m = Number(ms), d = Number(ds), h = Number(hs ?? 0), minute = Number(mins ?? 0), second = Number(ss ?? 0);
  if (y < 1 || m < 1 || m > 12 || d < 1 || h > 23 || minute > 59 || second > 59) return null;
  const calendar = new Date(0); calendar.setUTCFullYear(y, m - 1, d); calendar.setUTCHours(0, 0, 0, 0);
  if (calendar.getUTCMonth() !== m - 1 || calendar.getUTCDate() !== d) return null;
  if (zone) {
    if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return null;
    const instant = new Date(value.trim().replace(" ", "T"));
    return Number.isFinite(instant.getTime()) ? instant : null;
  }
  const local = new Date(0); local.setFullYear(y, m - 1, d); local.setHours(h, minute, second, Number((fraction ?? "").padEnd(3, "0")));
  if (local.getFullYear() !== y || local.getMonth() !== m - 1 || local.getDate() !== d) return null;
  // 只选日期保留当地日历日；明确钟点落在夏令时缺口则拒绝，不能顺延。
  if (hs !== undefined && (local.getHours() !== h || local.getMinutes() !== minute)) return null;
  return local;
}
