import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { control } from "./control";
import { computeWritable } from "./workspaces";
import { 是演示工作区 } from "../demo/config";
import { 演示码剩余, 演示码扣一次, 演示对话上限 } from "./activation";

/**
 * 演示区的访客 id：/demo 用演示码进入时种下的 cookie。
 * 演示区是所有访客共用一个工作区，AI 次数只能按人算，而没有账号的"人"只能用它认。
 * 不在请求上下文里（脚本、测试）时返回 null。
 */
export const 演示访客Cookie = "demo_visitor";
async function 演示访客id(): Promise<string | null> {
  try {
    return (await cookies()).get(演示访客Cookie)?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * 试用期的 AI 对话免费额度。
 *
 * 和 lib/ai-quota.ts 是两回事，别搞混：
 *   ai-quota      五分钟 30 次、内存态、重启清零 —— 防的是脚本刷爆，人正常用碰不到
 *   这里          落库的赠送账本 —— 这是产品定价的一部分
 *
 * 规则对标 eigent（注册送一笔、每天用就再送一点、邀请码多送）：
 *   注册赠送 30 次；余额不足 30 的，当天有使用就送 3 次（一天一次）；填了邀请码再送 50。
 * 余额 = AiGrant 之和 − AiUsage.calls。赠送只加不减，扣费仍是 AiUsage 的原子自增。
 *
 * 按**工作区**算而不是按人头，和定价口径一致（PLANS 的注释：按工作区收费，
 * 不按人头）。按人头的话，一个团队拉五个同事进来就有 25 次，闸门形同虚设。
 *
 * 额度和试用天数是两条独立的线：试用到期后数据只读，AI 也一并停掉——那是花钱的动作。
 * 付费之后不限：付了钱还数次数就成了另一种产品。自部署版整个不走这里。
 */
export const 注册赠送 = 30;
export const 每日赠送 = 3;
/** 余额低于这个数，当天才送。攒着不用的人不会无限累积 */
export const 每日赠送门槛 = 30;
export const 邀请码赠送 = 50;

/** 每日赠送的「天」按北京时间算，和服务器时区、用户所在地都无关，免得跨时区的人一天领两次 */
export function 今天(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export type 额度判定 =
  | { ok: true; 用掉: number; 还剩: number | null }
  | { ok: false; error: string; 用掉: number };

/**
 * 记一笔赠送。带幂等键的重复调用静默跳过（返回 false），由唯一索引替我们判，
 * 不先查再插——两个标签页同时打开首页时，先查再插会送两遍。
 */
export async function 赠送(input: { workspaceId: string; amount: number; reason: string; key?: string; note?: string }): Promise<boolean> {
  if (input.amount <= 0) return false;
  try {
    await control.aiGrant.create({
      data: { workspaceId: input.workspaceId, amount: input.amount, reason: input.reason, key: input.key ?? randomUUID(), note: input.note ?? null },
    });
    return true;
  } catch {
    return false;
  }
}

async function 赠送总和(workspaceId: string): Promise<number> {
  const r = await control.aiGrant.aggregate({ where: { workspaceId }, _sum: { amount: true } });
  return r._sum.amount ?? 0;
}

async function 用掉次数(workspaceId: string): Promise<number> {
  const u = await control.aiUsage.findUnique({ where: { workspaceId } });
  return u?.calls ?? 0;
}

/**
 * 试用工作区每次被看到时结一次账：没领过注册赠送的补上（老工作区也能拿到），
 * 今天还没领每日赠送、余额又不足门槛的领一份。只对试用中、可写的工作区做；付费和过期的都不用。
 *
 * 注册赠送在这里补而不是只在注册动作里发，是为了让改版之前开出来的工作区
 * 不需要任何数据迁移就自动进入新规则。
 */
async function 结算赠送(workspaceId: string): Promise<void> {
  await 赠送({ workspaceId, amount: 注册赠送, reason: "signup", key: `${workspaceId}:signup` });
  const [送, 用] = await Promise.all([赠送总和(workspaceId), 用掉次数(workspaceId)]);
  if (送 - 用 >= 每日赠送门槛) return;
  await 赠送({ workspaceId, amount: 每日赠送, reason: "daily", key: `${workspaceId}:daily:${今天()}` });
}

/** 只看不扣。页面拿它显示「还剩几次」，顺带把当天的赠送结掉 */
export async function 查额度(workspaceId: string): Promise<{ 上限: number; 用掉: number; 还剩: number; 受限: boolean }> {
  const ws = await control.workspace.findUnique({ where: { id: workspaceId } });
  // 演示区：按访客的演示码算，不看工作区的付费态（它为了永不过期被标成了付费）
  if (是演示工作区(ws?.slug)) {
    const v = await 演示访客id();
    const d = v ? await 演示码剩余(v) : null;
    return { 上限: 演示对话上限, 用掉: d?.用掉 ?? 演示对话上限, 还剩: d?.还剩 ?? 0, 受限: true };
  }
  const 受限 = Boolean(ws) && !已付费(ws!);
  if (ws && 受限 && computeWritable(ws)) await 结算赠送(workspaceId);
  const [送, 用] = await Promise.all([赠送总和(workspaceId), 用掉次数(workspaceId)]);
  // 拦下的那次会减回去，但并发的瞬间计数可能短暂超过上限，对外夹一下
  return { 上限: 送, 用掉: Math.min(用, 送), 还剩: Math.max(0, 送 - 用), 受限 };
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
    return { ok: false, error: "试用已结束，AI 对话需要开通订阅后继续使用。数据仍可查看和导出。", 用掉: 0 };
  }

  // 当天第一次用就是「登录了」，先把今天的赠送结掉再扣
  await 结算赠送(workspaceId);
  const 上限 = await 赠送总和(workspaceId);

  /**
   * 先自增再判断，不是先判断再自增——后者在两个标签页同时提问时会各读到 29、
   * 各写 30，30 次额度被用掉 31 次。upsert 的 increment 由数据库保证原子。
   * 被拦下的那次要减回去：不减的话，被拦 10 次之后运营台补 10 次等于白补，
   * 明天送的 3 次也会先被这些空计数吃掉。
   */
  const after = await control.aiUsage.upsert({
    where: { workspaceId },
    create: { workspaceId, calls: 1 },
    update: { calls: { increment: 1 } },
  });

  if (after.calls > 上限) {
    await control.aiUsage.update({ where: { workspaceId }, data: { calls: { decrement: 1 } } });
    return {
      ok: false,
      error: `免费的 AI 对话次数已经用完，明天登录再送 ${每日赠送} 次。开通订阅后不限次数——其余功能不受影响，照常可用。`,
      用掉: 上限,
    };
  }
  return { ok: true, 用掉: after.calls, 还剩: 上限 - after.calls };
}

/** 运营台给某个工作区手动加次数（谈单时想让对方多试几次） */
export async function 加次数(workspaceId: string, amount: number, note?: string): Promise<void> {
  const n = Math.max(1, Math.min(1000, Math.floor(amount)));
  await 赠送({ workspaceId, amount: n, reason: "admin", note });
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
  /**
   * 演示区：按演示码（cookie）扣，不走工作区额度。
   * 演示区为了永不过期被标成了付费态，走下面那条会被当付费客户直接放行——
   * 那就是"所有人共用、不限次"的账单黑洞。这里必须先拦。
   */
  if (是演示工作区(t.slug)) {
    const v = await 演示访客id();
    if (!v) return "请先用演示码进入演示区";
    const r = await 演示码扣一次(v);
    return r.ok ? null : r.error;
  }
  const r = await 扣一次额度(t.workspaceId);
  return r.ok ? null : r.error;
}
