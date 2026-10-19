/**
 * 回放时认出来的「别人新建的」客户 / 商机 / 跟进，先放进这个箱子，等 /api/desktop/sync 取走（team-notice.ts）。
 * 单独一个文件、不引别的：local.ts 要引它，不能把桌面端的凭据、账号那一串带进同步核心。
 */
export type 新插 = { t: "Customer" | "Opportunity" | "FollowUp"; k: string; h: string };
const 要的表 = new Set(["Customer", "Opportunity", "FollowUp"]);
/** 一直没人来取（壳是老版本、连着服务器模式）也不无限涨 */
const 箱子上限 = 5000;
const 箱 = globalThis as { __同事新插?: 新插[] };

export function 记新插(e: { t: string; k: string; h: string }) {
  if (!要的表.has(e.t)) return;
  const a = (箱.__同事新插 ??= []);
  a.push({ t: e.t as 新插["t"], k: e.k, h: e.h });
  if (a.length > 箱子上限) a.splice(0, a.length - 箱子上限);
}

export function 取走新插(): 新插[] {
  const a = 箱.__同事新插 ?? [];
  箱.__同事新插 = [];
  return a;
}

