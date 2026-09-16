import { control } from "./control";
import { computeWritable } from "./workspaces";
import * as 账本 from "./credits";

/**
 * 托管版网页端的 AI 免费次数。
 *
 * 规则和账本本身在 credits.ts——那一份实现同时服务桌面端（按账号算）。
 * 这里只负责网页端特有的两件事：
 *   1. 付费工作区不限次也不计数
 *   2. 到期 / 停用的工作区连第一次都不给
 *
 * 网页版现在只有一个长期运行的共享工作区（2026-09-16）。它**故意不标成付费**：
 * 标成付费就是不限次，而那套账号密码要发给多个团队——等于把模型账单敞开。
 * 它靠「到期日设在很远」来永远可写，AI 次数照常按账本限。
 *
 * 和 lib/ai-quota.ts 是两回事，别搞混：
 *   ai-quota      五分钟 30 次、内存态、重启清零 —— 防的是脚本刷爆，人正常用碰不到
 *   这里          落库的赠送账本 —— 这是产品定价的一部分
 */

export const { 注册赠送, 每日赠送, 每日赠送门槛, 今天 } = 账本;

/** 这个工作区的账本归属 */
const 归属 = (workspaceId: string): 账本.Owner => ({ kind: "workspace", id: workspaceId });

export type 额度判定 =
  | { ok: true; 用掉: number; 还剩: number | null }
  | { ok: false; error: string; 用掉: number };

/** 记一笔赠送。带幂等键的重复调用静默跳过 */
export async function 赠送(input: { workspaceId: string; amount: number; reason: string; key?: string; note?: string }): Promise<boolean> {
  return 账本.赠送(归属(input.workspaceId), input);
}

/** 付费期内不限次。注意「标着 ACTIVE 但过期了」不算付费，以日期为准 */
function 已付费(ws: { status: string; trialEndsAt: Date; paidUntil: Date | null }): boolean {
  return Boolean(ws.paidUntil && ws.paidUntil > new Date());
}

/** 只看不扣。页面拿它显示「还剩几次」，顺带把当天的赠送结掉 */
export async function 查额度(workspaceId: string): Promise<{ 上限: number; 用掉: number; 还剩: number; 受限: boolean }> {
  const ws = await control.workspace.findUnique({ where: { id: workspaceId } });
  const 受限 = Boolean(ws) && !已付费(ws!);
  // 过期和付费的都不结算：送了也用不上，账本别乱
  if (ws && 受限 && computeWritable(ws)) await 账本.结算赠送(归属(workspaceId));
  return { ...(await 账本.余额(归属(workspaceId))), 受限 };
}

/**
 * 扣一次额度。放行返回 ok，超了返回一句给人看的话。
 */
export async function 扣一次额度(workspaceId: string): Promise<额度判定> {
  const ws = await control.workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) return { ok: false, error: "工作区不存在", 用掉: 0 };

  // 付费工作区不计数也不拦——连计数都省掉，免得日后有人拿这个数字去做别的判断
  if (已付费(ws)) return { ok: true, 用掉: 0, 还剩: null };

  // 停用或过期的工作区本来就是只读，AI 也一并停掉：那是花钱的动作
  if (!computeWritable(ws)) {
    return { ok: false, error: "试用已结束，AI 对话需要开通订阅后继续使用。数据仍可查看和导出。", 用掉: 0 };
  }

  const r = await 账本.扣一次(归属(workspaceId));
  if (!r.ok) {
    return {
      ok: false,
      error: `免费的 AI 对话次数已经用完，明天登录再送 ${账本.每日赠送} 次。开通订阅后不限次数——其余功能不受影响，照常可用。`,
      用掉: r.上限,
    };
  }
  return { ok: true, 用掉: (await 账本.用掉次数(归属(workspaceId))), 还剩: r.还剩 };
}

/** 运营台给某个工作区手动加次数（谈单时想让对方多试几次） */
export async function 加次数(workspaceId: string, amount: number, note?: string): Promise<void> {
  const n = Math.max(1, Math.min(1000, Math.floor(amount)));
  await 账本.赠送(归属(workspaceId), { amount: n, reason: "admin", note });
}

/**
 * 路由级闸门：放行返回 null，拦下返回一句给人看的话。
 *
 * 覆盖**所有** AI 入口而不只是对话。理由是这个额度限的是"试用期免费烧多少钱"，
 * 而简报、话术、盯盘解读每一次也都是真金白银的上游调用——
 * 只堵对话等于留了三扇不上锁的门。
 * 自部署版（没开 MULTI_TENANT）整个不走这里，一次都不限。
 */
export async function 试用额度闸门(): Promise<string | null> {
  const { multiTenant } = await import("./context");
  if (!multiTenant()) return null;
  const { resolveCurrentTenant } = await import("./resolve");
  const t = await resolveCurrentTenant();
  // 没有工作区上下文时不在这里报错：调用方自己的 requireUser 会给出更清楚的提示
  if (!t) return null;
  const r = await 扣一次额度(t.workspaceId);
  return r.ok ? null : r.error;
}
