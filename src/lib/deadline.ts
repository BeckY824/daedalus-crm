import { dayjs } from "./utils";

/**
 * 计划和待办的「什么时候要做」一律这么写（审查 D1）：
 *   已经过了   —— 「逾期 N 天」（今天早些时候到期的算「今天 HH:mm」，还没到一整天）
 *   今天 / 明天 —— 「今天 14:00」「明天 09:00」
 *   更远       —— 「10 月 7 日」，跨年补年份
 *
 * 原来记录页的待办写「2 天前」（红色），计划页写「2026-09-24 10:00」，首页写「已逾期 2 天」——
 * 同一件事三种说法。「2 天前」读起来像一件发生过的事，不像一件欠着没做的事。
 * 和 smartTime 分开：smartTime 说的是「上一次是什么时候」，这里说的是「欠着的那件什么时候到」。
 */
export function 截止说法(d: Date | string | null | undefined, now = dayjs()): string {
  if (!d) return "没定时间";
  const t = dayjs(d);
  const 过了几天 = now.startOf("day").diff(t.startOf("day"), "day");
  if (过了几天 >= 1) return `逾期 ${过了几天} 天`;
  if (过了几天 === 0) return `今天 ${t.format("HH:mm")}`;
  if (过了几天 === -1) return `明天 ${t.format("HH:mm")}`;
  return t.isSame(now, "year") ? t.format("M 月 D 日") : t.format("YYYY 年 M 月 D 日");
}

/** 这件事拖过了没有：截止时刻已经过去（今天早些时候到期的也算） */
export function 已过期(d: Date | string | null | undefined, now = dayjs()): boolean {
  return Boolean(d) && dayjs(d).isBefore(now);
}
