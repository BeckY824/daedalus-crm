import { dayjs } from "../utils";
const periods = ["recent", "this_month", "last_month", "this_week", "last_week"] as const;
export function recapRange(args: Record<string, unknown>, now = new Date()) {
  const period = args.period ?? "recent";
  if (!periods.includes(period as typeof periods[number])) return null;
  const n = typeof args.days === "number" && Number.isFinite(args.days) ? Math.min(90, Math.max(1, Math.round(args.days))) : 7;
  const current = dayjs(now);
  if (period === "recent") return { from: current.subtract(n, "day").startOf("day").toDate(), to: now, label: `最近 ${n} 天`, days: n };
  const month = period === "this_month" || period === "last_month";
  const previous = period === "last_month" || period === "last_week";
  const base = previous ? current.subtract(1, month ? "month" : "week") : current;
  const unit = month ? "month" : "week";
  const from = base.startOf(unit).toDate();
  const to = previous ? base.endOf(unit).toDate() : now;
  return { from, to, label: month ? previous ? "上月" : "本月" : previous ? "上周" : "本周", days: dayjs(to).diff(from, "day") + 1 };
}
