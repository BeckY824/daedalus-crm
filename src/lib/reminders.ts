/**
 * 桌面端提醒要的那一份摘要：Dock 上的数字、早上那条汇总、到点提醒，都从这里算。
 *
 * **口径和「跟进计划」那一页的「我的」一模一样**（follow-ups/plans/PlansView.tsx 的分组）：
 *   逾期 = 计划时间早于今天零点，还没做
 *   今天 = 今天零点到明天零点之间，还没做
 * Dock 上那个数 = 逾期 + 今天。两处说的必须是同一件事——
 * Dock 写 5、点进去只看见 3 个，人就再也不信那个数了。
 *
 * 「定了时间的」：时刻不是零点的那些。只选了日期、没选钟点的计划存下来是当天零点，
 * 那种不该在半夜十二点叫人。定了时刻的（「3 点给王总回电话」）到点提醒一次。
 *
 * 纯函数：不碰库、不看时区设置以外的任何东西。按本机时区算——桌面端的本地服务
 * 和人坐在同一台电脑前，本机的「今天」就是他的今天。
 */

export type 提醒项 = {
  id: string;
  kind: "plan" | "task";
  标题: string;
  时间: Date | null;
  customerId: string;
  客户: string;
  方式?: string | null;
};

export type 定时项 = { key: string; at: string; 标题: string; 客户: string; customerId: string; 方式?: string | null };

export type 提醒摘要 = {
  逾期: number;
  今天: number;
  /** 从 10 分钟前到往后 24 小时之内、定了时刻的。壳每分钟拿一次，到点的发通知 */
  定时: 定时项[];
  /** 逾期里最久的那一个，早上那条汇总要点名 */
  最久: { 客户: string; 天: number } | null;
};

const 天 = 86_400_000;

function 零点(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 定了钟点的：本机时区下时分不全是 0 */
export function 定了时刻(t: Date): boolean {
  return t.getHours() !== 0 || t.getMinutes() !== 0;
}

export function 算提醒(项: 提醒项[], now = new Date()): 提醒摘要 {
  const 今天开始 = 零点(now);
  const 明天开始 = new Date(今天开始.getFullYear(), 今天开始.getMonth(), 今天开始.getDate() + 1);
  let 逾期 = 0;
  let 今天 = 0;
  let 最早逾期: 提醒项 | null = null;
  const 定时: 定时项[] = [];

  for (const x of 项) {
    if (!x.时间) continue;
    const t = x.时间;
    if (t < 今天开始) {
      逾期++;
      if (!最早逾期 || t < 最早逾期.时间!) 最早逾期 = x;
    } else if (t < 明天开始) {
      今天++;
    }
    // 10 分钟的回看：壳一分钟问一次，偶尔错过一轮（电脑刚醒）也还接得住
    if (定了时刻(t) && t.getTime() >= now.getTime() - 10 * 60_000 && t.getTime() < now.getTime() + 天) {
      定时.push({ key: `${x.kind}:${x.id}`, at: t.toISOString(), 标题: x.标题, 客户: x.客户, customerId: x.customerId, 方式: x.方式 ?? null });
    }
  }
  定时.sort((a, b) => a.at.localeCompare(b.at));

  const 最久 = 最早逾期
    ? { 客户: 最早逾期.客户, 天: Math.round((今天开始.getTime() - 零点(最早逾期.时间!).getTime()) / 天) }
    : null;
  return { 逾期, 今天, 定时, 最久 };
}
