import { control } from "./control";
import { computeWritable } from "./workspaces";
import { 当前是测试账号 } from "./test-accounts";
import * as 账本 from "./credits";
import type { AiFeature } from "../ai-usage";

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

export const { 注册赠送 } = 账本;

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

  // 停用或过期的工作区本来就是只读，AI 也一并停掉：那是花钱的动作
  if (!computeWritable(ws)) {
    return { ok: false, error: "试用已结束，AI 对话需要开通订阅后继续使用。数据仍可查看和导出。", 用掉: 0 };
  }

  // 订阅豁免也必须通过停用/到期判断。
  if (已付费(ws)) return { ok: true, 用掉: 0, 还剩: null };

  const r = await 账本.扣一次(归属(workspaceId));
  if (!r.ok) {
    return {
      ok: false,
      error: "免费的 AI 对话次数已经用完。开通订阅后不限次数——其余功能不受影响，照常可用。",
      用掉: r.上限,
    };
  }
  return { ok: true, 用掉: (await 账本.用掉次数(归属(workspaceId))), 还剩: r.还剩 };
}

/**
 * 把刚才那一次退回去。**和 试用额度闸门() 对称**：它扣在分发之前，这个退在出错之后。
 *
 * 为什么「出错就退」而不是只退上游的错：从用户那一侧看，他点了一下、什么都没拿到，
 * 这一次就不该算在他头上——不管是模型超时、我们自己抛异常，还是工具查不动。
 * 想靠反复失败白嫖也没有意义：失败就是没有答案，限流那道闸另外管着循环脚本。
 *
 * **用户自己中断的不退**：那一次上游已经在跑了，钱是真花出去的（由调用方判断）。
 * 自部署版一次都不扣，所以这里也一次都不退。
 */
export async function 退一次额度(): Promise<void> {
  const { multiTenant } = await import("./context");
  if (!multiTenant()) return;
  const { resolveCurrentTenant } = await import("./resolve");
  const t = await resolveCurrentTenant();
  if (!t) return;
  const ws = await control.workspace.findUnique({ where: { id: t.workspaceId } });
  // 付费工作区当初就没扣（见 扣一次额度），这里自然也不退
  if (!ws || 已付费(ws)) return;
  await 账本.回退一次(归属(t.workspaceId));
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
  return (await 过闸()).拦;
}

/**
 * 工作区在设置里填了自己的模型 Key：请求发给他自己那家，花的是他的钱——不扣也不拦。
 * 和 lib/ai-meter.ts「填了自己 Key 的一次都不扣」是同一条规矩，角标那边也按这个不挂「1 次」。
 * 读不到设置（库还没建好之类）当作没填：宁可照常计次，也不能因为读失败就敞开。
 */
export async function 自带Key(): Promise<boolean> {
  try {
    const { 模型来源 } = await import("../llm-config");
    return (await 模型来源()) === "ui";
  } catch {
    return false;
  }
}

/** 拦了就给那句话；没拦时说清这一次是不是真扣了——没扣的（付费、自带 Key）出错也不该退 */
async function 过闸(): Promise<{ 拦: string | null; 扣了: boolean }> {
  const { multiTenant } = await import("./context");
  if (!multiTenant()) return { 拦: null, 扣了: false };
  const { resolveCurrentTenant } = await import("./resolve");
  const t = await resolveCurrentTenant();
  // 没有工作区上下文时不在这里报错：调用方自己的 requireUser 会给出更清楚的提示
  if (!t) return { 拦: null, 扣了: false };
  const ws = await control.workspace.findUnique({ where: { id: t.workspaceId } });
  if (!ws || !computeWritable(ws)) {
    return { 拦: ws ? "试用已结束或工作区已停用，AI 对话暂不可用。数据仍可查看和导出。" : "工作区不存在", 扣了: false };
  }
  if (await 自带Key() || await 当前是测试账号(t.workspaceId)) return { 拦: null, 扣了: false };
  const r = await 扣一次额度(t.workspaceId);
  if (!r.ok) return { 拦: r.error, 扣了: false };
  // 付费工作区放行但不计数（还剩 null），那一次也就无从退起
  return { 拦: null, 扣了: r.还剩 !== null };
}

/**
 * 花模型钱的入口一律套这一层：先过 试用额度闸门()，没给出答案就把那一次退回去。
 *
 *   额度不够   不跑 fn，原样返回闸门那句中文（和 /api/ai/stream 一字不差）
 *   fn 抛了    退一次，再把异常原样抛给调用方
 *   fn 回 ok:false（客户不存在、模型没答上来、太频繁……）  也退——人什么都没拿到
 *   调用方传了 中断 且已经中断   不退：上游已经在跑，钱是真花出去的（stream 的老约定）
 *
 * 自部署、桌面端（没开 MULTI_TENANT）闸门直接放行，退也是空操作——一次都不扣。
 *
 * `用途` 必须是 lib/ai-usage.ts 的 AI_FEATURES 里登记过的键：它和同一个动作里
 * recordAiUse() 记的是同一个键（tests/ai-allowance-gate.test.ts 钉着这两处对得上），
 * 这样「扣了哪一类」和「本月用量表里记的哪一类」永远是一回事。
 *
 * 为什么要包成一层而不是每处写两行：2026-09-28 之前只有 stream 过闸门，
 * 起草话术、起草邀请、AI 解析、盯盘解读、粘贴切分五扇门都没上锁——托管版照样无限免费。
 * 每处手写「扣 / 失败退」迟早漏一处，漏了不报错，只是悄悄不扣。
 */
export async function 带额度<T extends { ok: boolean }>(
  用途: AiFeature,
  fn: () => Promise<T>,
  opts: { 中断?: AbortSignal } = {},
): Promise<T | { ok: false; error: string }> {
  const { 拦, 扣了 } = await 过闸();
  if (拦) return { ok: false, error: 拦 };
  // 真扣了一次（托管版试用工作区、用的是我们的模型）才谈得上退。下面没走通就退
  const 该退 = () => 扣了 && !opts.中断?.aborted;
  let r: T;
  try {
    r = await fn();
  } catch (e) {
    if (该退()) await 退一次额度().catch(() => {});
    throw e;
  }
  if (!r.ok && 该退()) await 退一次额度().catch(() => {});
  return r;
}
