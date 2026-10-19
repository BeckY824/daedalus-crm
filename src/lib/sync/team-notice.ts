/**
 * 老板提醒：同事新建了客户 / 商机 / 跟进（2026-10-19 客户反馈第 1 条）。
 *
 * 改动记录里没有「谁建的」，也没有「这是新建」的标记，只能在回放那一刻认：
 *   - 回放（local.ts）插入一行本机原来没有的 客户 / 商机 / 跟进 → 记进这里的箱子（记新插）
 *   - 本地服务的 /api/desktop/sync 跑完一轮，取走箱子（同事新建提醒），筛完交给壳；壳决定发不发、怎么合并（desktop/team-notices.js）
 *
 * 筛掉的：
 *   - 不是老板那台（团队名单里的老板 = 本机登录的云端账号）：只有建团队的人收提醒
 *   - 本人录的（自己另一台电脑、自己的手机）：不提醒自己
 *   - 起点之前的：这台电脑第一次在这个团队里跑（老板的第二台电脑刚加入、重装后恢复）会把整队历史拉一遍，
 *     那些都不是「刚新建」。起点 = 这台第一次走到这里的时间，记在 $CRM_DATA_DIR/.team-notice.json
 *   - 起点包（钟是 0000000000000-snapshot）、新人入队时推的全量（钟从 1 开始数）：钟比起点早，同上
 *   - 回放之后又被清掉的（孤儿）：本机查不到这一行就不提
 *
 * 箱子放在 globalThis 上：/api/desktop/sync 和 lib/sync/client.ts 在同一个进程里，但开发模式下不同路由可能各打一份模块，
 * 「改完推一下」触发的那一轮也会回放——都记进同一个箱子，下一次壳来问时一起取走。
 */
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma";
import { 读 as 读云端凭据 } from "@/lib/desktop/cloud";
import { 团队身份id, 本机我 } from "@/lib/desktop/me";
import { 取走新插, type 新插 } from "./team-notice-box";

export type 同事新建 = {
  类: "客户" | "商机" | "跟进";
  /** 谁录的（User.id）和名字 */
  谁: string;
  谁名: string;
  /** 客户名 / 商机名 / 跟进挂的客户名 */
  名: string;
  /** 跟进的标题（只有跟进有） */
  题?: string;
  /** 点通知去哪一页 */
  去: string;
  /** 录的时间（毫秒，取改动的钟） */
  at: number;
};

const 钟毫秒 = (h: string) => {
  const n = Number(h.split("-")[0]);
  return Number.isFinite(n) ? n : 0;
};

function 起点文件(): string | null {
  const dir = process.env.CRM_DATA_DIR;
  return dir ? path.join(dir, ".team-notice.json") : null;
}

/** 这台电脑在这个团队里从什么时候起收提醒。第一次问（没有记录、换了团队）就记成现在 */
export function 提醒起点(teamId: string, 现在 = Date.now()): number {
  const f = 起点文件();
  if (!f) return 现在;
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8")) as { teamId?: string; 起点?: number };
    if (j.teamId === teamId && typeof j.起点 === "number") return j.起点;
  } catch { /* 没有或坏了：重记 */ }
  try { fs.writeFileSync(f, JSON.stringify({ teamId, 起点: 现在 }), { mode: 0o600 }); } catch { /* 记不上下次再记，最多多跳过一轮 */ }
  return 现在;
}

/**
 * 取走箱子、筛成要提醒的那几条。不是老板那台、或者没有 teamId，箱子照样清空（不攒着等以后一下弹出来）。
 * 团队：{ teamId, ownerAccountId }（.team.json 里那两项）
 */
export async function 同事新建提醒(db: PrismaClient, 团队: { teamId: string; ownerAccountId?: string } | null, 现在 = Date.now()): Promise<同事新建[]> {
  const 新 = 取走新插();
  if (!团队) return [];
  const 账号 = 读云端凭据()?.accountId;
  if (!账号 || !团队.ownerAccountId || 团队.ownerAccountId !== 账号) return [];
  const 起点 = 提醒起点(团队.teamId, 现在);
  // 同一行一轮里可能插了又被合并、或者两次回放都记了：按表 + 主键去重，保留最早的钟
  const 去重 = new Map<string, 新插>();
  for (const e of 新) {
    if (钟毫秒(e.h) < 起点) continue;
    const key = `${e.t}\u0000${e.k}`;
    const 有 = 去重.get(key);
    if (!有 || e.h < 有.h) 去重.set(key, e);
  }
  if (!去重.size) return [];
  const 我 = (await 本机我(db))?.id ?? 团队身份id(账号);
  const 按表 = (t: 新插["t"]) => [...去重.values()].filter((e) => e.t === t);
  const 客户们 = 按表("Customer"), 商机们 = 按表("Opportunity"), 跟进们 = 按表("FollowUp");

  // 谁录的：先看同一条的「新建」操作日志（录的人和负责人可以不是一个人：老板替业务员建），没有再按负责人
  const ids = [...去重.values()].map((e) => e.k);
  const 日志 = await db.auditLog.findMany({ where: { action: "create", entityId: { in: ids }, entity: { in: ["Customer", "Opportunity", "FollowUp"] } }, select: { entity: true, entityId: true, userId: true, userName: true } });
  const 录的人 = new Map(日志.map((l) => [`${l.entity}\u0000${l.entityId}`, l]));

  const [客户行, 商机行, 跟进行] = await Promise.all([
    客户们.length ? db.customer.findMany({ where: { id: { in: 客户们.map((e) => e.k) } }, select: { id: true, name: true, salesOwnerId: true } }) : [],
    商机们.length ? db.opportunity.findMany({ where: { id: { in: 商机们.map((e) => e.k) } }, select: { id: true, name: true, ownerId: true, customer: { select: { name: true } } } }) : [],
    跟进们.length ? db.followUp.findMany({ where: { id: { in: 跟进们.map((e) => e.k) } }, select: { id: true, title: true, ownerId: true, customerId: true, customer: { select: { name: true } } } }) : [],
  ]);
  const 草: Omit<同事新建, "谁名">[] = [];
  const 谁录 = (t: string, k: string, 负责人: string) => 录的人.get(`${t}\u0000${k}`)?.userId ?? 负责人;
  const 钟 = new Map([...去重.values()].map((e) => [`${e.t}\u0000${e.k}`, 钟毫秒(e.h)]));
  for (const r of 客户行) 草.push({ 类: "客户", 谁: 谁录("Customer", r.id, r.salesOwnerId), 名: r.name, 去: `/customers/${r.id}`, at: 钟.get(`Customer\u0000${r.id}`)! });
  for (const r of 商机行) 草.push({ 类: "商机", 谁: 谁录("Opportunity", r.id, r.ownerId), 名: r.name, 去: `/opportunities?opportunity=${encodeURIComponent(r.id)}`, at: 钟.get(`Opportunity\u0000${r.id}`)! });
  for (const r of 跟进行) 草.push({ 类: "跟进", 谁: 谁录("FollowUp", r.id, r.ownerId), 名: r.customer?.name ?? "", 题: r.title, 去: `/customers/${r.customerId}`, at: 钟.get(`FollowUp\u0000${r.id}`)! });
  const 别人的 = 草.filter((x) => x.谁 !== 我);
  if (!别人的.length) return [];
  const 人 = await db.user.findMany({ where: { id: { in: [...new Set(别人的.map((x) => x.谁))] } }, select: { id: true, name: true } });
  const 名字 = new Map(人.map((u) => [u.id, u.name]));
  const 日志名 = new Map(日志.map((l) => [l.userId, l.userName]));
  return 别人的
    .map((x) => ({ ...x, 谁名: 名字.get(x.谁) || 日志名.get(x.谁) || "同事" }))
    .sort((a, b) => a.at - b.at);
}
