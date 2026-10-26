"use server";
/**
 * 企业版线索分配的写操作（2026-10-24）：分配线索、设每人每月配额、看我分出去的线索、看本月分配情况。
 *
 * 生效条件 = 企业版() 且规则「线索分配和配额」开着（lib/enterprise/rules.ts），否则一律拒。
 * 规则判断（谁能分、能分给谁、算不算数）都在 lib/enterprise/lead-assign.ts 的纯函数里，这里读库、写库、留痕。
 */
import { revalidatePath } from "next/cache";
import { prisma, defaultClient } from "@/lib/prisma";
import { requireUser, type SessionUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { 不在了 } from "@/lib/not-there";
import { getSetting, invalidateSettingsCache } from "@/lib/settings";
import { 规则, 规则开着 } from "@/lib/enterprise/rules";
import { 读组织, type 组织 } from "@/lib/enterprise/org";
import { 查完再写 } from "@/lib/check-then-write";
import { 发企业提醒, 管理员们 } from "@/lib/enterprise/notice";
import { 读改权限, 谁能改的话 } from "@/lib/enterprise/edit-perm";
import {
  企划线索计数key, 我分出去的, 月份, 本月已分, 满了, 接手问题, 能分配, 能设配额, 能改参与, 线索种类, 计不计数, 配额of, 挑接手人, 挑的理由, 自动分配不参与key,
  type 分出去的线索, type 线,
} from "@/lib/enterprise/lead-assign";

type 结果 = { ok: true } | { ok: false; error: string };
const 没开: { ok: false; error: string } = { ok: false, error: `规则「${规则.线索分配.名}」没开：老板或总管理员在 设置 → 组织架构 里打开` };

/** 规则开着才放行；共享试用区不让分 */
async function 进门() {
  if (!(await 规则开着("线索分配"))) return null;
  const me = await requireUser();
  const { 当前是共享区 } = await import("@/lib/shared-ws/current");
  if (await 当前是共享区()) return null;
  return me;
}

const 是线 = (x: unknown): x is 线 => x === "内贸" || x === "外贸";

export async function 分配线索(input: { leadId: string; toUserId: string; line?: 线 | null; kind?: 线索种类 }): Promise<结果> {
  const me = await 进门();
  if (!me) return 没开;
  const line = input.line ?? null;
  const kind = input.kind ?? "营销";
  if (line !== null && !是线(line)) return { ok: false, error: "业务线只能是内贸或外贸" };
  if (!线索种类.includes(kind)) return { ok: false, error: "线索种类只能是营销或营销企划" };
  try {
    const org = await 读组织();
    if (!能分配(org, me)) return { ok: false, error: "只有老板、总管理员、市场管理能分配线索" };
    const r = await 分给(me, org, { leadId: input.leadId, toUserId: input.toUserId, line, kind });
    return r.ok ? r : { ok: false, error: r.error };
  } catch (e) {
    return 不在了(e);
  }
}

/**
 * 分配线索()、自动分配线索() 共用的那一段：进门、能不能分已经查过。
 * 配额检查和写入在同一个事务里（查完再写）：两个人同时把线索分给同一个人，后到的那个查的时候先到的已经写完，不会超配额。
 * 分满了带 满: true，自动分配据此顺延到下一个人
 */
async function 分给(
  me: SessionUser, org: 组织, input: { leadId: string; toUserId: string; line: 线 | null; kind: 线索种类 },
): Promise<{ ok: true } | { ok: false; error: string; 满?: true }> {
  const 问题 = 接手问题(org, input.toUserId, input.line);
  if (问题) return { ok: false, error: 问题 };

  // 走限定过的连接：「按组织架构看客户」开着时，看不到的线索当不在
  const lead = await prisma.lead.findFirst({ where: { id: input.leadId }, select: { id: true, name: true } });
  if (!lead) return { ok: false, error: "这条线索已经不在了（或者你看不到它），刷新看看" };

  const counted = 计不计数(input.kind, await getSetting<boolean>(企划线索计数key));
  const 月 = 月份();
  const 落库 = await 查完再写(async (tx): Promise<{ ok: true; fromUserId: string | null } | { ok: false; error: string; 满?: true }> => {
    // 负责人、状态在事务里再读一次：同一条线索两边同时分，后到的看到的是先到的写完的
    const 现在 = await tx.lead.findUnique({ where: { id: lead.id }, select: { ownerId: true, status: true } });
    if (!现在) return { ok: false, error: "这条线索已经不在了（或者你看不到它），刷新看看" };
    if (现在.status === "已转化") return { ok: false, error: "已转化的线索不用再分" };
    if (现在.ownerId === input.toUserId) return { ok: false, error: "这条线索已经在他名下了" };
    if (counted) {
      const 已分 = await 本月已分(input.toUserId, 月, tx);
      const 配额 = await 配额of(input.toUserId, tx);
      if (满了(已分, 配额)) return { ok: false, 满: true, error: `他这个月已经分了 ${已分} 条，配额 ${配额} 条，分满了：找他的上级调配额，或者分给别人` };
    }
    await tx.lead.update({ where: { id: lead.id }, data: { ownerId: input.toUserId } });
    await tx.entLeadAssign.create({
      data: { leadId: lead.id, toUserId: input.toUserId, fromUserId: 现在.ownerId, byUserId: me.id, line: input.line, kind: input.kind, counted, month: 月 },
    });
    return { ok: true, fromUserId: 现在.ownerId };
  });
  if (!落库.ok) return 落库;

  const { line } = input;
  const 接手 = await prisma.user.findUnique({ where: { id: input.toUserId }, select: { name: true } });
  await recordAudit({
    user: me, action: "update", entity: "Lead", entityId: lead.id,
    summary: `分配线索「${lead.name}」给 ${接手?.name ?? input.toUserId}${line ? `（${line}）` : ""}${counted ? "" : "，不计数"}`,
    detail: { toUserId: input.toUserId, fromUserId: 落库.fromUserId, line, kind: input.kind, counted, month: 月 },
  });
  revalidatePath("/leads");
  return { ok: true };
}

export type 自动分配结果 =
  | { ok: true; toUserId: string; 接手人: string; 已分: number; 配额: number | null; 为什么: string }
  | { ok: false; error: string };

/** 不参与名单：Setting 里存的值不是数组（没设、被手改坏）都当没人不参与 */
function 认名单(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
async function 不参与名单(): Promise<string[]> {
  return 认名单(await getSetting<unknown>(自动分配不参与key));
}

/**
 * 自动分配（D-38）：在职、能接这条线、参与自动分配、填了配额（不是 0）、本月没分满的人里，挑「本月已分 / 配额」比例最低的；并列给最早进池的。
 * 挑中以后走 分给()，配额、留痕和手动分一样；挑完到落库之间他被别人分满了，就顺延到下一个人。
 * 成了带上接手人、分完以后本月已分几条、配额、为什么挑他，界面直接拿去提示
 */
export async function 自动分配线索(leadId: string, opts: { line?: 线 | null; kind?: 线索种类 } = {}): Promise<自动分配结果> {
  const me = await 进门();
  if (!me) return 没开;
  const line = opts.line ?? null;
  const kind = opts.kind ?? "营销";
  if (line !== null && !是线(line)) return { ok: false, error: "业务线只能是内贸或外贸" };
  if (!线索种类.includes(kind)) return { ok: false, error: "线索种类只能是营销或营销企划" };
  try {
    const org = await 读组织();
    if (!能分配(org, me)) return { ok: false, error: "只有老板、总管理员、市场管理能分配线索" };
    return await 自动分给(me, org, leadId, line, kind);
  } catch (e) {
    return 不在了(e);
  }
}

/** 自动分配线索()、批量自动分配() 共用：进门、能不能分已经查过 */
async function 自动分给(me: SessionUser, org: 组织, leadId: string, line: 线 | null, kind: 线索种类): Promise<自动分配结果> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId }, select: { ownerId: true, status: true, name: true } });
  if (!lead) return { ok: false, error: "这条线索已经不在了（或者你看不到它），刷新看看" };
  if (lead.status === "已转化") return { ok: false, error: "已转化的线索不用再分" };

  const 人们 = [...org.成员.keys()].filter((id) => id !== lead.ownerId && 接手问题(org, id, line) === null);
  const 月 = 月份();
  const [计数, 配额, 建号, 不参与, 企划算数] = await Promise.all([
    prisma.entLeadAssign.groupBy({ by: ["toUserId"], where: { month: 月, counted: true, toUserId: { in: 人们 } }, _count: { _all: true } }),
    prisma.entLeadQuota.findMany({ where: { userId: { in: 人们 } } }),
    prisma.user.findMany({ where: { id: { in: 人们 } }, select: { id: true, name: true, createdAt: true } }),
    不参与名单(),
    getSetting<boolean>(企划线索计数key),
  ]);
  const 数 = new Map(计数.map((c) => [c.toUserId, c._count._all]));
  const 额 = new Map(配额.map((q) => [q.userId, q.quota]));
  const 候选 = 建号.map((u) => ({ userId: u.id, 已分: 数.get(u.id) ?? 0, 配额: 额.get(u.id) ?? null, 进池: u.createdAt }));
  const 跳过 = new Set(不参与);
  const 查满 = 计不计数(kind, 企划算数);
  // 每轮要么分成、要么把挑中的人加进跳过，挑接手人不会再挑他：最多轮完一遍候选
  for (;;) {
    const 谁 = 挑接手人(候选, 跳过, 查满);
    if (!谁) {
      // 参与的人里有填了配额的（含 0）、只是都分满了 →「都已满额」：线索不动，市场管理、总管理员各收一条提醒
      // （A8，10-26；同类没读的只留一条，见 lib/enterprise/notice.ts）。参与的人都没填配额、一个参与的都没有，各是另一回事
      const 参与的 = 候选.filter((c) => !不参与.includes(c.userId));
      if (参与的.some((c) => c.配额 !== null)) {
        await 发企业提醒(管理员们(org, ["市场管理", "总管理员"]), {
          kind: "线索满额",
          title: "自动分配：参与的人都已满额",
          body: `线索「${lead.name}」没分出去，留在原处。找他们的上级调配额，或者手动分。`,
          link: "/settings?tab=org#lead-assign",
        });
        return { ok: false, error: "都已满额，没有能接的人：线索留在原处，已提醒市场管理和总管理员；找他们的上级调配额，或者手动分" };
      }
      return {
        ok: false,
        error: 参与的.length
          ? "没有能接的人：没填配额，不参与自动分配。找他们的上级填配额，或者手动分"
          : "没有能接的人：都不参与自动分配，或者业务线对不上",
      };
    }
    const 为什么 = 挑的理由(候选, 跳过, 查满, 谁);
    const r = await 分给(me, org, { leadId, toUserId: 谁, line, kind });
    if (r.ok) {
      return { ok: true, toUserId: 谁, 接手人: 建号.find((u) => u.id === 谁)?.name ?? 谁, 已分: await 本月已分(谁, 月), 配额: 额.get(谁) ?? null, 为什么 };
    }
    if (!r.满) return { ok: false, error: r.error };
    跳过.add(谁);
  }
}

export type 批量自动分配结果 = { leadId: string; name: string } & 自动分配结果;
const 批量最多 = 200;

/**
 * 勾了几条一起自动分配（D-38）：一条一条按顺序分，前一条分完再挑下一条的人，
 * 所以连分 10 条和点 10 次单条结果一样；每条成没成都列出来。一次最多 200 条
 */
export async function 批量自动分配(leadIds: string[]): Promise<{ ok: true; 结果: 批量自动分配结果[] } | { ok: false; error: string }> {
  const me = await 进门();
  if (!me) return 没开;
  const ids = [...new Set(Array.isArray(leadIds) ? leadIds.filter((x) => typeof x === "string") : [])];
  if (!ids.length) return { ok: false, error: "先勾选要分的线索" };
  if (ids.length > 批量最多) return { ok: false, error: `一次最多自动分配 ${批量最多} 条，分几次点` };
  try {
    const org = await 读组织();
    if (!能分配(org, me)) return { ok: false, error: "只有老板、总管理员、市场管理能分配线索" };
    const 名 = new Map((await prisma.lead.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((l) => [l.id, l.name]));
    const 结果: 批量自动分配结果[] = [];
    for (const id of ids) {
      let r: 自动分配结果;
      try {
        r = await 自动分给(me, org, id, null, "营销");
      } catch (e) {
        r = 不在了(e);
      }
      结果.push({ leadId: id, name: 名.get(id) ?? "（看不到这条）", ...r });
    }
    return { ok: true, 结果 };
  } catch (e) {
    return 不在了(e);
  }
}

/** 暂停 / 恢复某人参与自动分配（Q-12 默认：老板、总管理员、销售管理能改；直属上级只能看）。手动分配不受影响 */
export async function 设自动分配参与(userId: string, 参与: boolean): Promise<结果> {
  const me = await 进门();
  if (!me) return 没开;
  if (typeof 参与 !== "boolean") return { ok: false, error: "参与只能是开或关" };
  try {
    const org = await 读组织();
    if (!能改参与(org, me)) return { ok: false, error: "只有老板、总管理员、销售管理能改谁参与自动分配" };
    if (接手问题(org, userId, null)) return { ok: false, error: "这个人不在组织里、已经停用，或者不是销售 / 销售管理" };
    // 读-改-写放进一个事务：两个人同时拨不同人的开关，后写的不会把先写的盖掉
    const 变了 = await 查完再写(async (tx) => {
      const 行 = await tx.setting.findUnique({ where: { key: 自动分配不参与key } });
      let 原值: unknown = null;
      try { 原值 = 行 ? JSON.parse(行.value) : null; } catch { /* 被手改坏：当没人不参与 */ }
      const 现在 = 认名单(原值);
      const 新 = 参与 ? 现在.filter((x) => x !== userId) : [...new Set([...现在, userId])];
      // 按内容比：本来就是这样就不写设置、不留痕
      if (JSON.stringify(新) === JSON.stringify(现在)) return false;
      const value = JSON.stringify(新);
      await tx.setting.upsert({ where: { key: 自动分配不参与key }, update: { value }, create: { key: 自动分配不参与key, value } });
      return true;
    });
    if (!变了) return { ok: true };
    invalidateSettingsCache();
    const 人 = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    await recordAudit({
      user: me, action: "update", entity: "EntLeadAssign", entityId: userId,
      summary: 参与 ? `恢复 ${人?.name ?? userId} 参与自动分配` : `暂停 ${人?.name ?? userId} 参与自动分配`,
    });
    revalidatePath("/leads");
    revalidatePath("/settings");
    return { ok: true };
  } catch (e) {
    return 不在了(e);
  }
}

/** 设每月配额；quota = null 是清空配额（手动分不限，自动分配不再挑他） */
export async function 设配额(userId: string, quota: number | null): Promise<结果> {
  const me = await 进门();
  if (!me) return 没开;
  if (quota !== null && (!Number.isInteger(quota) || quota < 0 || quota > 10000)) return { ok: false, error: "配额填 0 到 10000 的整数；不设就清空" };
  try {
    const org = await 读组织();
    if (!org.成员.has(userId)) return { ok: false, error: "这个人不在组织里，或者已经停用" };
    const 改权限 = await 读改权限();
    if (!能设配额(org, me, userId, 改权限)) return { ok: false, error: `线索配额${谁能改的话(改权限, "线索配额")}` };
    if (quota === null) await prisma.entLeadQuota.deleteMany({ where: { userId } });
    else await prisma.entLeadQuota.upsert({ where: { userId }, update: { quota, setById: me.id }, create: { userId, quota, setById: me.id } });
    const 人 = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    await recordAudit({
      user: me, action: "update", entity: "EntLeadQuota", entityId: userId,
      summary: quota === null ? `取消 ${人?.name ?? userId} 的线索配额` : `把 ${人?.name ?? userId} 的线索配额设成每月 ${quota} 条`,
    });
    revalidatePath("/leads");
    revalidatePath("/settings");
    return { ok: true };
  } catch (e) {
    return 不在了(e);
  }
}

/** 我分出去的线索和转化情况；规则没开返回 null */
export async function 我分出去的线索(): Promise<分出去的线索[] | null> {
  const me = await 进门();
  if (!me) return null;
  return 我分出去的(me.id);
}

export type 分配情况 = {
  userId: string;
  name: string;
  line: string | null;
  已分: number;
  配额: number | null;
  /** 当前持有：他名下待跟进、跟进中的线索，月初不清 */
  持有: number;
  参与: boolean;
  能设配额: boolean;
  能改参与: boolean;
}[];

/**
 * 本月每个能接线索的人分了几条、配额多少、手上还有几条、参与没参与自动分配（设置 → 组织架构 →「线索分配」那一屏用）。
 * 分配的人、能改参与的人看全部；上级只看自己能设配额的那几位；都不是 = 空。规则没开返回 null
 */
export async function 本月分配情况(): Promise<分配情况 | null> {
  const me = await 进门();
  if (!me) return null;
  const org = await 读组织();
  const 全看 = 能分配(org, me) || 能改参与(org, me);
  const 改参与 = 能改参与(org, me);
  const 改权限 = await 读改权限();
  const 人们 = [...org.成员.values()].filter((m) => 接手问题(org, m.userId, null) === null && (全看 || 能设配额(org, me, m.userId, 改权限)));
  const ids = 人们.map((m) => m.userId);
  const 月 = 月份();
  const [计数, 配额, 持有, 名字, 不参与] = await Promise.all([
    prisma.entLeadAssign.groupBy({ by: ["toUserId"], where: { month: 月, counted: true, toUserId: { in: ids } }, _count: { _all: true } }),
    prisma.entLeadQuota.findMany({ where: { userId: { in: ids } } }),
    // 持有数不受「按组织架构看客户」限定：上级看下属手上几条，本来就该看得到这个数
    defaultClient.lead.groupBy({ by: ["ownerId"], where: { ownerId: { in: ids }, status: { in: ["待跟进", "跟进中"] } }, _count: { _all: true } }),
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, createdAt: true } }),
    不参与名单(),
  ]);
  const 数 = new Map(计数.map((c) => [c.toUserId, c._count._all]));
  const 额 = new Map(配额.map((q) => [q.userId, q.quota]));
  const 持 = new Map(持有.map((c) => [c.ownerId, c._count._all]));
  const 停 = new Set(不参与);
  // 和自动分配挑人的先后一样排：进池早的在前
  const 人 = new Map(名字.map((u) => [u.id, u]));
  return 人们
    .filter((m) => 人.has(m.userId))
    .sort((a, b) => 人.get(a.userId)!.createdAt.getTime() - 人.get(b.userId)!.createdAt.getTime())
    .map((m) => ({
      userId: m.userId, name: 人.get(m.userId)!.name, line: m.line,
      已分: 数.get(m.userId) ?? 0, 配额: 额.get(m.userId) ?? null, 持有: 持.get(m.userId) ?? 0,
      参与: !停.has(m.userId), 能设配额: 能设配额(org, me, m.userId, 改权限), 能改参与: 改参与,
    }));
}
