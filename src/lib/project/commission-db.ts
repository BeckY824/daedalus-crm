/**
 * 企业版提成的读写（2026-10-26，迁移 051；算法在 commission.ts）。只在服务端用。
 *
 * 谁能干什么（10-26 总控定，PR 里写明）：
 *   - 填 / 改项目底价：只有项目负责人（项目在公海里时不算），老板、总管理员也不代填（10-26 定）
 *   - 改分配：组长（项目负责人，项目在公海里时不算）、老板（ADMIN）、组织里的总管理员
 *   - 改 A / B（提成比例）：老板、总管理员
 *   - 看提成卡：上面这些人 + 已进组的组员 + 业务主管（MANAGER）+ 负责人的直属上级、虚线上级
 * 不是企业版：每个动作直接拦、一行不写；读一律 null；赢单挂钩什么都不做
 */
import type { Prisma } from "@/generated/prisma";
import { 查完再写 } from "../check-then-write";
import { getSetting, invalidateSettingsCache } from "../settings";
import { 企业版 } from "@/lib/enterprise/switch";
import { 读组织, 直属上级of, 虚线上级of, 管理员类别of, type 组织 } from "@/lib/enterprise/org";
import {
  提成比例键, 规整提成比例, 提成比例问题, 两位, 算提成, 底价问题, 分配问题, 分到每人,
  type 提成比例, type 分配, type 提成卡,
} from "./commission";

type 谁 = { id: string; role: string };
type 错 = { ok: false; error: string };
const 没开企业版: 错 = { ok: false, error: "提成是企业版的功能" };
const 项目不在: 错 = { ok: false, error: "这个项目已经不在了，刷新看看" };

const 总管理员 = (me: 谁, org: 组织 | null) => !!org && 管理员类别of(org, me.id) === "总管理员";

/** 改提成比例（A / B）：老板、组织里的总管理员 */
export function 能改提成比例(me: 谁, org: 组织 | null): boolean {
  return me.role === "ADMIN" || 总管理员(me, org);
}

/** 填 / 改项目底价：只有项目负责人（不在公海），老板、总管理员也不代填（10-26 定） */
export function 能填底价(me: 谁, p: { ownerId: string; pooledAt?: Date | null }): boolean {
  return !p.pooledAt && me.id === p.ownerId;
}

/** 改分配：组长（不在公海）、老板、总管理员。业务主管能看不能改 */
export function 能改提成(me: 谁, p: { ownerId: string; pooledAt?: Date | null }, org: 组织 | null): boolean {
  return (!p.pooledAt && me.id === p.ownerId) || 能改提成比例(me, org);
}

/** 看提成卡：能改的人、已进组的组员、业务主管、负责人的直属 / 虚线上级 */
export function 能看提成(me: 谁, p: { ownerId: string; pooledAt?: Date | null }, 在组: ReadonlySet<string>, org: 组织 | null): boolean {
  if (能改提成(me, p, org) || me.id === p.ownerId || 在组.has(me.id) || me.role === "MANAGER") return true;
  return !!org && (直属上级of(org, p.ownerId) === me.id || 虚线上级of(org, p.ownerId) === me.id);
}

export async function 读提成比例(): Promise<提成比例> {
  return 规整提成比例(await getSetting(提成比例键));
}

/** 事务里读比例：getSetting 走事务外的连接和缓存，事务里只用 tx */
async function 事务里的比例(tx: Prisma.TransactionClient): Promise<提成比例> {
  const r = await tx.setting.findUnique({ where: { key: 提成比例键 } });
  let v: unknown = null;
  try { v = r ? JSON.parse(r.value) : null; } catch { v = null; }
  return 规整提成比例(v);
}

/** 改 A / B。返回改前改后，操作记录在 action 里记 */
export async function 改提成比例(me: 谁, input: { 底价比例?: unknown; 溢价比例?: unknown }): Promise<错 | { ok: true; 变了: boolean; 前: 提成比例; 后: 提成比例 }> {
  if (!企业版()) return 没开企业版;
  if (!能改提成比例(me, await 读组织())) return { ok: false, error: "只有老板或总管理员能改提成比例" };
  const 问题 = 提成比例问题(input);
  if (问题) return { ok: false, error: 问题 };
  const 后: 提成比例 = { 底价比例: 两位(input.底价比例 as number), 溢价比例: 两位(input.溢价比例 as number) };
  const r = await 查完再写(async (tx) => {
    const 前 = await 事务里的比例(tx);
    if (前.底价比例 === 后.底价比例 && 前.溢价比例 === 后.溢价比例) return { ok: true as const, 变了: false, 前, 后 };
    const value = JSON.stringify(后);
    await tx.setting.upsert({ where: { key: 提成比例键 }, update: { value }, create: { key: 提成比例键, value } });
    return { ok: true as const, 变了: true, 前, 后 };
  });
  if (r.变了) invalidateSettingsCache();
  return r;
}

const 项目字段 = { id: true, name: true, ownerId: true, pooledAt: true, phase: true, customerId: true } as const;

/**
 * 填 / 改 / 清项目底价。已经赢单固定了的不让改（要改先退回商机）；
 * 在订单阶段还没固定（赢单时底价没填）的，填上那一刻按当时的比例固定
 */
export async function 存项目底价(me: 谁, projectId: string, 底价: number | null): Promise<错 | { ok: true; 变了: boolean; 前?: number | null; 后?: number | null; 固定了?: boolean; name?: string; customerId?: string }> {
  if (!企业版()) return 没开企业版;
  return 查完再写(async (tx) => {
    const p = await tx.project.findUnique({ where: { id: String(projectId ?? "") }, select: 项目字段 });
    if (!p) return 项目不在;
    if (!能填底价(me, p)) return { ok: false as const, error: p.pooledAt ? "这个项目在公海里，先领取再改" : "项目底价由项目负责人填" };
    const 问题 = 底价问题(底价);
    if (问题) return { ok: false as const, error: 问题 };
    const 值 = 底价 == null ? null : 两位(底价);
    const 有 = await tx.entCommission.findUnique({ where: { projectId: p.id } });
    if (有?.fixedAt) return { ok: false as const, error: "已经赢单，实际提成已固定；要改项目底价先把项目退回商机" };
    const 前 = 有?.basePrice ?? null;
    if (前 === 值) return { ok: true as const, 变了: false };
    await tx.entCommission.upsert({
      where: { projectId: p.id },
      create: { projectId: p.id, basePrice: 值, updatedById: me.id },
      update: { basePrice: 值, updatedById: me.id },
    });
    const 固定了 = p.phase === "订单" && 值 != null ? await 固定实际提成(tx, p.id) : false;
    return { ok: true as const, 变了: true, 前, 后: 值, 固定了, name: p.name, customerId: p.customerId };
  });
}

/**
 * 改分配：整份换掉（没列的人、填 0 的人 = 不分）。只能分给已进组（JOINED）的组员，组长自己不占一行；
 * 每人 0–100、合计 ≤ 100%，剩下的归组长
 */
export async function 存提成分配(me: 谁, projectId: string, 分: 分配): Promise<错 | { ok: true; 变了: boolean; 前?: 分配; 后?: 分配; name?: string; customerId?: string; ownerId?: string }> {
  if (!企业版()) return 没开企业版;
  const org = await 读组织();
  return 查完再写(async (tx) => {
    const p = await tx.project.findUnique({ where: { id: String(projectId ?? "") }, select: 项目字段 });
    if (!p) return 项目不在;
    if (!能改提成(me, p, org)) return { ok: false as const, error: p.pooledAt ? "这个项目在公海里，先领取再改" : "只有组长（项目负责人）或管理员能改提成分配" };
    if (!分 || typeof 分 !== "object" || Array.isArray(分)) return { ok: false as const, error: "分配的格式不对，刷新再试" };
    if (Object.hasOwn(分, p.ownerId)) return { ok: false as const, error: "组长自己不用分，剩下的都归组长" };
    const 问题 = 分配问题(分);
    if (问题) return { ok: false as const, error: 问题 };
    const 后: 分配 = {};
    for (const [uid, v] of Object.entries(分)) if (v > 0) 后[uid] = 两位(v);
    const 在组 = new Set((await tx.projectMember.findMany({ where: { projectId: p.id, inviteStatus: "JOINED" }, select: { userId: true } })).map((m) => m.userId));
    if (Object.keys(后).some((uid) => !在组.has(uid))) return { ok: false as const, error: "只能分给已经进组（同意了邀请）的组员，刷新看看" };
    const 旧 = await tx.entCommissionSplit.findMany({ where: { projectId: p.id } });
    const 前: 分配 = Object.fromEntries(旧.map((s) => [s.userId, s.percent]));
    const 一样 = Object.keys(前).length === Object.keys(后).length && Object.entries(后).every(([uid, v]) => 前[uid] === v);
    if (一样) return { ok: true as const, 变了: false };
    await tx.entCommissionSplit.deleteMany({ where: { projectId: p.id, userId: { notIn: Object.keys(后) } } });
    for (const [userId, percent] of Object.entries(后)) {
      await tx.entCommissionSplit.upsert({
        where: { projectId_userId: { projectId: p.id, userId } },
        create: { projectId: p.id, userId, percent, setById: me.id },
        update: { percent, setById: me.id },
      });
    }
    return { ok: true as const, 变了: true, 前, 后, name: p.name, customerId: p.customerId, ownerId: p.ownerId };
  });
}

/** 按此刻的成交金额、底价、比例把实际提成固定下来。底价没填、已经固定过 → 不动，返回 false */
async function 固定实际提成(tx: Prisma.TransactionClient, projectId: string): Promise<boolean> {
  const c = await tx.entCommission.findUnique({ where: { projectId } });
  if (!c || c.basePrice == null || c.fixedAt) return false;
  const p = await tx.project.findUnique({ where: { id: projectId }, select: { amount: true } });
  if (!p) return false;
  const 比例 = await 事务里的比例(tx);
  const 算 = 算提成(p.amount, c.basePrice, 比例)!;
  await tx.entCommission.update({
    where: { projectId },
    data: { fixedAt: new Date(), fixedDeal: 算.成交金额, fixedBase: 算.项目底价, fixedRateBase: 比例.底价比例, fixedRatePremium: 比例.溢价比例, fixedTotal: 算.合计 },
  });
  return true;
}

/**
 * 节点变了（lib/project/db.ts 改节点、按必填推进 在同一笔事务里调）：
 * 从别的阶段进到订单 = 赢单，固定实际提成；从订单退回去 = 清掉固定的，再赢单按那时的比例重算。不是企业版什么都不做
 */
export async function 节点变了的提成(tx: Prisma.TransactionClient, projectId: string, 从: string, 到: string): Promise<void> {
  if (!企业版() || 从 === 到) return;
  if (到 === "订单") await 固定实际提成(tx, projectId);
  else if (从 === "订单") {
    await tx.entCommission.updateMany({
      where: { projectId, fixedAt: { not: null } },
      data: { fixedAt: null, fixedDeal: null, fixedBase: null, fixedRateBase: null, fixedRatePremium: null, fixedTotal: null },
    });
  }
}

/** 项目详情的提成卡：不是企业版、看不了 → null。叫 = id → 名字（页面上已经查过人） */
export async function 读项目提成(
  me: 谁,
  p: { id: string; ownerId: string; pooledAt: Date | null; amount: number; currency: string },
  在组ids: readonly string[],
  org: 组织 | null,
  叫: (uid: string) => string,
  db: Pick<Prisma.TransactionClient, "entCommission" | "entCommissionSplit">,
): Promise<提成卡 | null> {
  if (!企业版()) return null;
  const 在组 = new Set(在组ids);
  if (!能看提成(me, p, 在组, org)) return null;
  const [c, 分, 比例] = await Promise.all([
    db.entCommission.findUnique({ where: { projectId: p.id } }),
    db.entCommissionSplit.findMany({ where: { projectId: p.id }, orderBy: { percent: "desc" } }),
    读提成比例(),
  ]);
  const 预估 = 算提成(p.amount, c?.basePrice, 比例);
  const 实际 = c?.fixedAt && c.fixedBase != null && c.fixedRateBase != null && c.fixedRatePremium != null
    ? (() => {
        const 当时 = { 底价比例: c.fixedRateBase!, 溢价比例: c.fixedRatePremium! };
        const 算 = 算提成(c.fixedDeal, c.fixedBase, 当时)!;
        return { ...算, 合计: c.fixedTotal ?? 算.合计, 比例: 当时, 固定于: c.fixedAt!.toISOString() };
      })()
    : null;
  const 每人 = 分到每人(实际 ? 实际.合计 : 预估?.合计 ?? null, p.ownerId, 分, 在组).map((x) => ({ ...x, name: 叫(x.userId) }));
  return {
    币种: p.currency, 成交金额: p.amount, 项目底价: c?.basePrice ?? null, 比例, 预估, 实际, 每人,
    能改: 能改提成(me, p, org),
    能填底价: 能填底价(me, p),
    组员: [...在组].filter((uid) => uid !== p.ownerId).map((uid) => ({ userId: uid, name: 叫(uid) })),
    分配: Object.fromEntries(分.filter((s) => 在组.has(s.userId)).map((s) => [s.userId, s.percent])),
  };
}
