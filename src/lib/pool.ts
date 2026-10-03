/**
 * 公海（2026-10-03，0.46.15 第 6 块）——只放规矩和说法，浏览器和服务端共用。读写库在 lib/pool-db.ts。
 *
 * 轻量版：有 CustomerPool 这一行 = 在公海；原负责人不清空，列表上写「公海（原 X）」，谁领了才换人。
 * 只在多人时出现——一个人用的库里，公海就是自己的抽屉，没有意义。
 */
import { dayjs } from "@/lib/utils";

/** 签了的、流失的不掉公海：前者是自己的老客户，后者本来就没人要再跟 */
export const 不掉公海的状态: readonly string[] = ["已签约", "已流失"];

/**
 * N 天没跟进了吗：没跟进过的按建档时间算；从公海领走过的，领走那天之前的不算。
 * 按自然日比，和盯盘「N 天没联系」一个口径（lib/sentinel.ts）。天数 0 = 没开自动掉公海，一律不掉。
 */
export function 该掉公海(
  c: { followStatus: string; lastFollowAt: Date | string | null; createdAt: Date | string; claimedAt?: Date | string | null },
  天数: number,
  今: Date = new Date(),
): boolean {
  if (!(天数 > 0) || 不掉公海的状态.includes(c.followStatus)) return false;
  const 起 = [c.lastFollowAt ?? c.createdAt, c.claimedAt].filter(Boolean).map((t) => dayjs(t!)).reduce((a, b) => (b.isAfter(a) ? b : a));
  return dayjs(今).startOf("day").diff(起.startOf("day"), "day") >= 天数;
}

/** 自动掉进去的截止线：最近跟进（没有就建档）早于这一刻的才掉。给查库用，和 该掉公海 同一个口径 */
export function 公海截止(天数: number, 今: Date = new Date()): Date {
  return dayjs(今).startOf("day").subtract(天数 - 1, "day").toDate();
}

/** 列表负责人那一格、记录页头上的标签 */
export function 公海标签(原负责人?: string | null): string {
  return 原负责人 ? `公海（原 ${原负责人}）` : "公海";
}

/** 自动掉进去的理由，日志和标签提示里都用这一句 */
export const 自动理由 = (天数: number) => `${天数} 天没跟进，自动放进公海`;
