"use server";
/**
 * 企业版线索分配的写操作（2026-10-24）：分配线索、设每人每月配额、看我分出去的线索、看本月分配情况。
 *
 * 生效条件 = 企业版() 且规则「线索分配和配额」开着（lib/enterprise/rules.ts），否则一律拒。
 * 规则判断（谁能分、能分给谁、算不算数）都在 lib/enterprise/lead-assign.ts 的纯函数里，这里读库、写库、留痕。
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { 不在了 } from "@/lib/not-there";
import { getSetting } from "@/lib/settings";
import { 规则, 规则开着 } from "@/lib/enterprise/rules";
import { 读组织 } from "@/lib/enterprise/org";
import {
  企划线索计数key, 我分出去的, 月份, 本月已分, 满了, 接手问题, 能分配, 能设配额, 线索种类, 计不计数, 配额of,
  type 分出去的线索, type 线,
} from "@/lib/enterprise/lead-assign";

type 结果 = { ok: true } | { ok: false; error: string };
const 没开: 结果 = { ok: false, error: `规则「${规则.线索分配.名}」没开：老板或总管理员在 设置 → 组织架构 里打开` };

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
    const 问题 = 接手问题(org, input.toUserId, line);
    if (问题) return { ok: false, error: 问题 };

    // 走限定过的连接：「按组织架构看客户」开着时，看不到的线索当不在
    const lead = await prisma.lead.findFirst({ where: { id: input.leadId }, select: { id: true, name: true, ownerId: true, status: true } });
    if (!lead) return { ok: false, error: "这条线索已经不在了（或者你看不到它），刷新看看" };
    if (lead.status === "已转化") return { ok: false, error: "已转化的线索不用再分" };
    if (lead.ownerId === input.toUserId) return { ok: false, error: "这条线索已经在他名下了" };

    const counted = 计不计数(kind, await getSetting<boolean>(企划线索计数key));
    const 月 = 月份();
    if (counted) {
      const [已分, 配额] = await Promise.all([本月已分(input.toUserId, 月), 配额of(input.toUserId)]);
      if (满了(已分, 配额)) return { ok: false, error: `他这个月已经分了 ${已分} 条，配额 ${配额} 条，分满了：找他的上级调配额，或者分给别人` };
    }

    await prisma.lead.update({ where: { id: lead.id }, data: { ownerId: input.toUserId } });
    await prisma.entLeadAssign.create({
      data: { leadId: lead.id, toUserId: input.toUserId, fromUserId: lead.ownerId, byUserId: me.id, line, kind, counted, month: 月 },
    });
    const 接手 = await prisma.user.findUnique({ where: { id: input.toUserId }, select: { name: true } });
    await recordAudit({
      user: me, action: "update", entity: "Lead", entityId: lead.id,
      summary: `分配线索「${lead.name}」给 ${接手?.name ?? input.toUserId}${line ? `（${line}）` : ""}${counted ? "" : "，不计数"}`,
      detail: { toUserId: input.toUserId, fromUserId: lead.ownerId, line, kind, counted, month: 月 },
    });
    revalidatePath("/leads");
    return { ok: true };
  } catch (e) {
    return 不在了(e);
  }
}

/** 设每月配额；quota = null 是取消配额（不限） */
export async function 设配额(userId: string, quota: number | null): Promise<结果> {
  const me = await 进门();
  if (!me) return 没开;
  if (quota !== null && (!Number.isInteger(quota) || quota < 0 || quota > 10000)) return { ok: false, error: "配额填 0 到 10000 的整数；不限就清空" };
  try {
    const org = await 读组织();
    if (!org.成员.has(userId)) return { ok: false, error: "这个人不在组织里，或者已经停用" };
    if (!能设配额(org, me, userId)) return { ok: false, error: "只有他的直属上级、虚线上级，或者老板、总管理员能设配额" };
    if (quota === null) await prisma.entLeadQuota.deleteMany({ where: { userId } });
    else await prisma.entLeadQuota.upsert({ where: { userId }, update: { quota, setById: me.id }, create: { userId, quota, setById: me.id } });
    const 人 = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    await recordAudit({
      user: me, action: "update", entity: "EntLeadQuota", entityId: userId,
      summary: quota === null ? `取消 ${人?.name ?? userId} 的线索配额` : `把 ${人?.name ?? userId} 的线索配额设成每月 ${quota} 条`,
    });
    revalidatePath("/leads");
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

export type 分配情况 = { userId: string; line: string | null; 已分: number; 配额: number | null; 能设配额: boolean }[];

/** 本月每个能接线索的人分了几条、配额多少（分配的人和上级用）；规则没开返回 null */
export async function 本月分配情况(): Promise<分配情况 | null> {
  const me = await 进门();
  if (!me) return null;
  const org = await 读组织();
  const 人们 = [...org.成员.values()].filter((m) => 接手问题(org, m.userId, null) === null);
  const 月 = 月份();
  const [计数, 配额] = await Promise.all([
    prisma.entLeadAssign.groupBy({ by: ["toUserId"], where: { month: 月, counted: true }, _count: { _all: true } }),
    prisma.entLeadQuota.findMany(),
  ]);
  const 数 = new Map(计数.map((c) => [c.toUserId, c._count._all]));
  const 额 = new Map(配额.map((q) => [q.userId, q.quota]));
  const 全看 = 能分配(org, me);
  return 人们
    .map((m) => ({ userId: m.userId, line: m.line, 已分: 数.get(m.userId) ?? 0, 配额: 额.get(m.userId) ?? null, 能设配额: 能设配额(org, me, m.userId) }))
    // 分配的人看全部；上级只看自己能设配额的那几位
    .filter((r) => 全看 || r.能设配额);
}
