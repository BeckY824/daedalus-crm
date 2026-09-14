import { randomUUID } from "node:crypto";
import { control } from "./control";

/**
 * AI 免费次数的赠送账本。
 *
 * 同一套规则，两种归属方：
 *   workspace —— 托管版网页端：一个团队一个工作区，次数按工作区算（和定价口径一致，
 *                按人头算的话拉五个同事进来就有五份）
 *   account   —— 桌面端本地模式：数据在用户自己机器上，我们只认账号，次数按人算
 *
 * 规则对标 eigent：注册送 30；余额不足 30 的，当天有使用就送 3（一天一次）。
 * 余额 = 赠送之和 − 用掉次数。赠送只加不减。
 *
 * 原来还有一档「填邀请码再送 50」，整套码 2026-09-15 下线时一起去掉了。
 * 运营台的「AI +10」还在——要给谁多送几次，那条路更直接，也不用先发一个码出去。
 *
 * 为什么两种归属方分了两张表却共用这一份实现：控制面的迁移只能加表不能改表
 * （SQLite 没有 ADD COLUMN IF NOT EXISTS，而 control-migrations/ 每次启动整个重跑），
 * 而 AiGrant 已经按 workspaceId 建好了。表分开，规则只有一份——
 * 规则要是抄两遍，改定价时必然漏一边。
 */

export type Owner = { kind: "workspace"; id: string } | { kind: "account"; id: string };

export const 注册赠送 = 30;
export const 每日赠送 = 3;
/** 余额低于这个数，当天才送。攒着不用的人不会无限累积 */
export const 每日赠送门槛 = 30;

/** 每日赠送的「天」按北京时间算，和服务器时区、用户所在地都无关，免得跨时区的人一天领两次 */
export function 今天(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * 记一笔赠送。带幂等键的重复调用静默跳过（返回 false），由唯一索引替我们判，
 * 不先查再插——两个标签页同时打开首页时，先查再插会送两遍。
 */
export async function 赠送(owner: Owner, input: { amount: number; reason: string; key?: string; note?: string }): Promise<boolean> {
  if (input.amount <= 0) return false;
  const data = { amount: input.amount, reason: input.reason, key: input.key ?? randomUUID(), note: input.note ?? null };
  try {
    if (owner.kind === "workspace") await control.aiGrant.create({ data: { ...data, workspaceId: owner.id } });
    else await control.accountAiGrant.create({ data: { ...data, accountId: owner.id } });
    return true;
  } catch {
    return false;
  }
}

export async function 赠送总和(owner: Owner): Promise<number> {
  const r =
    owner.kind === "workspace"
      ? await control.aiGrant.aggregate({ where: { workspaceId: owner.id }, _sum: { amount: true } })
      : await control.accountAiGrant.aggregate({ where: { accountId: owner.id }, _sum: { amount: true } });
  return r._sum.amount ?? 0;
}

export async function 用掉次数(owner: Owner): Promise<number> {
  const u =
    owner.kind === "workspace"
      ? await control.aiUsage.findUnique({ where: { workspaceId: owner.id } })
      : await control.accountAiUsage.findUnique({ where: { accountId: owner.id } });
  return u?.calls ?? 0;
}

/** 原子自增，返回自增后的值。不先读再写：两个标签页同时问会各读到 29、各写 30 */
export async function 自增用量(owner: Owner): Promise<number> {
  const after =
    owner.kind === "workspace"
      ? await control.aiUsage.upsert({ where: { workspaceId: owner.id }, create: { workspaceId: owner.id, calls: 1 }, update: { calls: { increment: 1 } } })
      : await control.accountAiUsage.upsert({ where: { accountId: owner.id }, create: { accountId: owner.id, calls: 1 }, update: { calls: { increment: 1 } } });
  return after.calls;
}

/** 超额被拦下的那一次要还回去，否则被拦十次之后补的十次等于白补 */
export async function 回退一次(owner: Owner): Promise<void> {
  if (owner.kind === "workspace") await control.aiUsage.update({ where: { workspaceId: owner.id }, data: { calls: { decrement: 1 } } });
  else await control.accountAiUsage.update({ where: { accountId: owner.id }, data: { calls: { decrement: 1 } } });
}

/**
 * 结一次账：没领过注册赠送的补上，今天还没领、余额又不足门槛的领一份。
 *
 * 注册赠送在这里补而不是只在注册时发，是为了让改版之前就存在的工作区和账号
 * 不需要任何数据迁移就自动进入新规则。
 */
export async function 结算赠送(owner: Owner): Promise<void> {
  await 赠送(owner, { amount: 注册赠送, reason: "signup", key: `${owner.id}:signup` });
  const [送, 用] = await Promise.all([赠送总和(owner), 用掉次数(owner)]);
  if (送 - 用 >= 每日赠送门槛) return;
  await 赠送(owner, { amount: 每日赠送, reason: "daily", key: `${owner.id}:daily:${今天()}` });
}

/** 只看不扣 */
export async function 余额(owner: Owner): Promise<{ 上限: number; 用掉: number; 还剩: number }> {
  const [送, 用] = await Promise.all([赠送总和(owner), 用掉次数(owner)]);
  // 拦下的那次会还回去，但并发的瞬间计数可能短暂超过上限，对外夹一下
  return { 上限: 送, 用掉: Math.min(用, 送), 还剩: Math.max(0, 送 - 用) };
}

/**
 * 扣一次。放行返回 ok，超了返回还剩多少（0）。
 *
 * 扣在真正发起模型调用**之前**：失败的那次也算。限的是"发起"而不是"成功"，
 * 否则一个反复失败的问题可以无限重试，而每次重试都是真金白银的上游调用。
 * 先自增再判断，超了再还回去——顺序反过来在并发下会多放行。
 */
export async function 扣一次(owner: Owner): Promise<{ ok: true; 还剩: number } | { ok: false; 上限: number }> {
  await 结算赠送(owner);
  const 上限 = await 赠送总和(owner);
  const after = await 自增用量(owner);
  if (after > 上限) {
    await 回退一次(owner);
    return { ok: false, 上限 };
  }
  return { ok: true, 还剩: 上限 - after };
}
