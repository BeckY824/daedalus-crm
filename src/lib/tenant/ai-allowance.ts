import { control } from "./control";
import { computeWritable } from "./workspaces";

/**
 * 试用期的 AI 对话免费额度。
 *
 * 和 lib/ai-quota.ts 是两回事，别搞混：
 *   ai-quota      五分钟 30 次、内存态、重启清零 —— 防的是脚本刷爆，人正常用碰不到
 *   这里          试用期一共 5 次、落库、永不重置 —— 这是产品定价的一部分
 *
 * 按**工作区**算而不是按人头，和定价口径一致（PLANS 的注释：按工作区收费，
 * 不按人头）。按人头的话，一个团队拉五个同事进来就有 25 次，闸门形同虚设。
 *
 * 付费之后不限：付了钱还数次数就成了另一种产品。自部署版整个不走这里。
 */
export const 试用对话上限 = 5;

export type 额度判定 =
  | { ok: true; 用掉: number; 还剩: number | null }
  | { ok: false; error: string; 用掉: number };

/** 只看不扣。页面拿它显示「还剩几次」 */
export async function 查额度(workspaceId: string): Promise<{ 上限: number; 用掉: number; 还剩: number; 受限: boolean }> {
  const [ws, u] = await Promise.all([
    control.workspace.findUnique({ where: { id: workspaceId } }),
    control.aiUsage.findUnique({ where: { workspaceId } }),
  ]);
  const 用掉 = u?.calls ?? 0;
  const 受限 = Boolean(ws) && !已付费(ws!);
  // 被拦下的次数也计在 calls 里，对外夹回上限，免得显示「已用 9 / 5」
  return { 上限: 试用对话上限, 用掉: Math.min(用掉, 试用对话上限), 还剩: Math.max(0, 试用对话上限 - 用掉), 受限 };
}

/** 付费期内不限次。注意「标着 ACTIVE 但过期了」不算付费，以日期为准 */
function 已付费(ws: { status: string; trialEndsAt: Date; paidUntil: Date | null }): boolean {
  return Boolean(ws.paidUntil && ws.paidUntil > new Date());
}

/**
 * 扣一次额度。放行返回 ok，超了返回一句给人看的话。
 *
 * 扣在真正发起模型调用**之前**：失败的那次也算。限的是"发起"而不是"成功"，
 * 否则一个反复失败的问题可以无限重试，而每次重试都是真金白银的上游调用。
 */
export async function 扣一次额度(workspaceId: string): Promise<额度判定> {
  const ws = await control.workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) return { ok: false, error: "工作区不存在", 用掉: 0 };

  // 付费工作区不计数也不拦——连计数都省掉，免得日后有人拿这个数字去做别的判断
  if (已付费(ws)) return { ok: true, 用掉: 0, 还剩: null };

  // 停用或过期的工作区本来就是只读，AI 也一并停掉：那是花钱的动作
  if (!computeWritable(ws)) {
    return { ok: false, error: "试用已结束，AI 对话需要开通订阅后继续使用。数据仍可查看和导出。", 用掉: 试用对话上限 };
  }

  /**
   * 原子自增。不先读再写：两个标签页同时问，读到的都是 4，
   * 各自写 5，于是 5 次额度被用掉 6 次。upsert 的 increment 由数据库保证。
   */
  const after = await control.aiUsage.upsert({
    where: { workspaceId },
    create: { workspaceId, calls: 1 },
    update: { calls: { increment: 1 } },
  });

  /**
   * 先自增再判断，不是先判断再自增——后者在两个标签页同时提问时会各读到 4、
   * 各写 5，5 次额度被用掉 6 次。代价是被拦下的那些次也会把计数顶过上限，
   * 所以对外报的数字要夹回去，别让人看到「已用 9 / 5」。
   */
  if (after.calls > 试用对话上限) {
    return {
      ok: false,
      error: `试用期的 ${试用对话上限} 次 AI 对话已经用完。开通订阅后不限次数——其余功能不受影响，照常可用。`,
      用掉: 试用对话上限,
    };
  }
  return { ok: true, 用掉: after.calls, 还剩: 试用对话上限 - after.calls };
}

/** 运营台给某个工作区重置额度（谈单时想让对方多试几次） */
export async function 重置额度(workspaceId: string): Promise<void> {
  await control.aiUsage.deleteMany({ where: { workspaceId } });
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
