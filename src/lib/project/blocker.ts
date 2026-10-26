/**
 * 企业版卡点（2026-10-26）的读写和谁能动。规矩（取值、编号、时限提醒）在 blocker-rules.ts。
 *
 * 卡点只能从项目上的一条沟通记录发出来；流转：
 *   发布（不指认 → 看板；指认别人 → 待接受；指认自己 → 处理中）
 *   看板上：项目上的人认领 → 处理中；能管的人 / 发布人指认 → 待接受
 *   待接受：被指认的人 接受 → 处理中 / 转让（必须选人）→ 给那位待接受 / 返回（必须写理由）→ 看板
 *   处理中：经手人 改进度、转让、返回、解决（写方案和结果）→ 已解决
 * 每一步记一行 EntBlockerLog：谁、什么时候、从谁到谁、理由。
 *
 * 谁看得到（E11，这里在代码里明着查，不靠团队范围——企业版没开「按组织架构看客户」时范围不限人）：
 *   老板、组织里的总管理员；项目负责人、点了同意的组员；卡点的经手人、发布人；
 *   负责人的实线上级（各级）、虚线上级（只能看）。其他人一条都拿不到，按 id 直连也一样。
 *   账号角色是主管不算数（企业版的主管看谁按组织架构走）。
 * 谁能管（指认、代改进度）：老板、总管理员、负责人本人、负责人的直属上级。
 * 读写都包在 看全部 里：权限已经在这里查过，组员不一定看得到负责人的客户
 */
import type { Prisma } from "@/generated/prisma";
import { prisma } from "../prisma";
import { 查完再写 } from "../check-then-write";
import { 看全部 } from "../team-scope";
import { getSetting, setSetting } from "../settings";
import { 企业版 } from "@/lib/enterprise/switch";
import { 读组织, 虚线上级of, 实线下属, 管理员类别of, type 组织 } from "@/lib/enterprise/org";
import { 挡改设置 } from "@/lib/enterprise/edit-perm";
import { 能管项目, 代管节点 } from "./db";
import {
  规整卡点默认, 合上卡点默认, 规整发布, 规整文字, 理由上限, 卡点编号前缀, 拼编号, 编号日, 下一个流水,
  type 卡点默认, type 发布输入, type 卡点状态,
} from "./blocker-rules";

type 谁 = { id: string; role: string };
type 结果 = { ok: true } | { ok: false; error: string };
/** 动过的卡点在哪个项目、编号多少（接口拿去刷新页面、写操作日志） */
export type 卡点结果 = { ok: true; projectId: string; code: string } | { ok: false; error: string };

const 没开 = { ok: false as const, error: "卡点是企业版的功能" };
const 不在了 = { ok: false as const, error: "这个卡点已经不在了，刷新看看" };
export const 卡点默认键 = "entBlockerDefaults";

export async function 读卡点默认(): Promise<卡点默认> {
  return 规整卡点默认(await getSetting<unknown>(卡点默认键));
}

/** 管理员改卡点默认（解决时限、阻碍主体选项、默认类型 / 影响）：和字典一样，谁能改看「编辑权限」的字典一项 */
export async function 存卡点默认(me: 谁, patch: unknown): Promise<结果 & { 默认?: 卡点默认 }> {
  if (!企业版()) return 没开;
  const 挡 = await 挡改设置(me, "字典");
  if (挡) return { ok: false, error: 挡 };
  const 新 = 合上卡点默认(await 读卡点默认(), patch);
  if ("error" in 新) return { ok: false, error: 新.error };
  await setSetting(卡点默认键, 新);
  return { ok: true, 默认: 新 };
}

type 项目要的 = { id: string; ownerId: string; pooledAt: Date | null; customerId: string; contactId: string | null; phase: string };
const 项目字段 = { id: true, ownerId: true, pooledAt: true, customerId: true, contactId: true, phase: true } as const;

async function 是组员(tx: Prisma.TransactionClient, projectId: string, userId: string): Promise<boolean> {
  const m = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } }, select: { inviteStatus: true } });
  return m?.inviteStatus === "JOINED";
}
async function 在职(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
  return (await tx.user.findUnique({ where: { id: userId }, select: { active: true } }))?.active === true;
}
/** 项目上的人 = 在职的负责人（项目不在公海）或点了同意的组员：只有他们能认领、被指认、被转让 */
async function 项目上的人(tx: Prisma.TransactionClient, p: 项目要的, userId: string): Promise<boolean> {
  if (!(await 在职(tx, userId))) return false;
  if (!p.pooledAt && p.ownerId === userId) return true;
  return 是组员(tx, p.id, userId);
}

/**
 * 能管 = 指认、改进度、看全部。企业版按组织架构：老板（ADMIN）、总管理员、负责人本人、负责人的直属上级；
 * 账号是主管不算（虚线上级、别的组的主管只能看或看不到，E11）。没组织架构退回项目模式的规矩
 */
function 能管卡点(me: 谁, p: 项目要的, org: 组织 | null): boolean {
  if (!org) return 能管项目(me, p);
  if (me.role === "ADMIN" || 管理员类别of(org, me.id) === "总管理员") return true;
  return !p.pooledAt && (p.ownerId === me.id || 代管节点(me, p.ownerId, org));
}

/** 只看不管的上级：实线各级上级（直属的在 能管卡点 里）、虚线上级 */
function 上级看得到(me: 谁, p: 项目要的, org: 组织 | null): boolean {
  if (!org) return false;
  return 虚线上级of(org, p.ownerId) === me.id || 实线下属(org, me.id).has(p.ownerId);
}

/** 这个人能不能看这个项目的卡点：项目上的人、能管的、上级（经手人、发布人另算，按卡点查） */
async function 能看项目卡点(tx: Prisma.TransactionClient, me: 谁, p: 项目要的, org: 组织 | null): Promise<boolean> {
  if (能管卡点(me, p, org) || 上级看得到(me, p, org)) return true;
  if (!p.pooledAt && p.ownerId === me.id) return true;
  return 是组员(tx, p.id, me.id);
}

type 卡点行 = Prisma.EntBlockerGetPayload<{ include: { project: { select: typeof 项目字段 } } }>;

async function 拿卡点(tx: Prisma.TransactionClient, blockerId: string): Promise<卡点行 | null> {
  return tx.entBlocker.findUnique({ where: { id: String(blockerId ?? "") }, include: { project: { select: 项目字段 } } });
}

async function 能看卡点(tx: Prisma.TransactionClient, me: 谁, b: 卡点行, org: 组织 | null): Promise<boolean> {
  return b.assigneeId === me.id || b.creatorId === me.id || 能看项目卡点(tx, me, b.project, org);
}

function 记(tx: Prisma.TransactionClient, blockerId: string, userId: string, action: string, extra: { fromUserId?: string | null; toUserId?: string | null; note?: string | null } = {}) {
  return tx.entBlockerLog.create({ data: { blockerId, userId, action, ...extra } });
}

async function 下一个卡点编号(tx: Prisma.TransactionClient, now: Date): Promise<string> {
  const 头 = `${卡点编号前缀}${编号日(now)}`;
  const 最大 = await tx.entBlocker.findFirst({ where: { code: { startsWith: 头 } }, orderBy: { code: "desc" }, select: { code: true } });
  return 拼编号(卡点编号前缀, now, 下一个流水(最大?.code, 卡点编号前缀, now), 3);
}

const 组织of = async () => (企业版() ? 读组织() : null);

/** 一段事务：企业版才进；权限在里面明着查，读写不过团队范围 */
async function 写<T extends { ok: true }>(fn: (tx: Prisma.TransactionClient, org: 组织 | null) => Promise<T | { ok: false; error: string }>): Promise<T | { ok: false; error: string }> {
  if (!企业版()) return 没开;
  const org = await 组织of();
  return 查完再写((tx) => 看全部(() => fn(tx, org)));
}

/**
 * 从一条沟通记录发布卡点。负责人、组员、能管的（老板、总管理员、直属上级）能发；项目在公海里不行。
 * 指认了人：那位得是项目上的人；指认自己 = 直接处理中
 */
export async function 发布卡点(
  me: 谁, followUpId: string, input: 发布输入, assigneeId?: string | null, now: Date = new Date(),
): Promise<结果 & { id?: string; code?: string; projectId?: string }> {
  if (!企业版()) return 没开;
  const 默认 = await 读卡点默认();
  return 写(async (tx, org) => {
    const fp = await tx.followUpProject.findUnique({ where: { followUpId: String(followUpId ?? "") }, include: { project: { select: 项目字段 } } });
    if (!fp) return { ok: false as const, error: "卡点要从项目上的一条沟通记录发，这条沟通找不到了，刷新看看" };
    const p = fp.project;
    if (p.pooledAt) return { ok: false as const, error: "这个项目在公海里，先领取再发卡点" };
    if (!能管卡点(me, p, org) && !(await 是组员(tx, p.id, me.id))) return { ok: false as const, error: "只有项目负责人、项目组成员、直属上级或老板能发卡点" };
    const 好 = 规整发布(input, 默认);
    if ("error" in 好) return { ok: false as const, error: 好.error };
    const 指 = assigneeId ? String(assigneeId) : null;
    if (指 && !(await 项目上的人(tx, p, 指))) return { ok: false as const, error: "只能指认给项目负责人或项目组成员（在职的）" };
    const status: 卡点状态 = !指 ? "看板" : 指 === me.id ? "处理中" : "待接受";
    const code = await 下一个卡点编号(tx, now);
    const b = await tx.entBlocker.create({
      data: {
        code, projectId: p.id, followUpId: fp.followUpId, customerId: p.customerId, contactId: p.contactId, phase: p.phase,
        type: 好.type, impact: 好.impact, obstacle: 好.obstacle, description: 好.description, dueDays: 好.dueDays,
        dueAt: new Date(now.getTime() + 好.dueDays * 24 * 3600_000), resourceRequest: 好.resourceRequest,
        status, assigneeId: 指, creatorId: me.id,
      },
    });
    await 记(tx, b.id, me.id, "publish", { toUserId: 指 });
    return { ok: true as const, id: b.id, code, projectId: p.id };
  });
}

/** 看板上的卡点指给一位项目上的人（能管的人或发布人） */
export async function 指认卡点(me: 谁, blockerId: string, userId: string): Promise<卡点结果> {
  return 写(async (tx, org) => {
    const b = await 拿卡点(tx, blockerId);
    if (!b || !(await 能看卡点(tx, me, b, org))) return 不在了;
    if (!能管卡点(me, b.project, org) && b.creatorId !== me.id) return { ok: false as const, error: "只有项目负责人、发布人、上级或老板能指认" };
    if (b.status !== "看板") return { ok: false as const, error: "这个卡点已经有人接了，刷新看看" };
    const to = String(userId ?? "");
    if (!(await 项目上的人(tx, b.project, to))) return { ok: false as const, error: "只能指认给项目负责人或项目组成员（在职的）" };
    await tx.entBlocker.update({ where: { id: b.id }, data: { status: to === me.id ? "处理中" : "待接受", assigneeId: to } });
    await 记(tx, b.id, me.id, "assign", { toUserId: to });
    return { ok: true as const, projectId: b.projectId, code: b.code };
  });
}

/** 项目上的人从看板认领 → 自己处理中 */
export async function 认领卡点(me: 谁, blockerId: string): Promise<卡点结果> {
  return 写(async (tx, org) => {
    const b = await 拿卡点(tx, blockerId);
    if (!b || !(await 能看卡点(tx, me, b, org))) return 不在了;
    if (b.status !== "看板") return { ok: false as const, error: "这个卡点已经有人接了，刷新看看" };
    if (!(await 项目上的人(tx, b.project, me.id))) return { ok: false as const, error: "只有项目负责人、项目组成员能认领" };
    await tx.entBlocker.update({ where: { id: b.id }, data: { status: "处理中", assigneeId: me.id } });
    await 记(tx, b.id, me.id, "claim", { toUserId: me.id });
    return { ok: true as const, projectId: b.projectId, code: b.code };
  });
}

/** 经手人本人的动作都先过这一道：卡点在、我是经手人、状态对 */
async function 我经手的(tx: Prisma.TransactionClient, me: 谁, blockerId: string, org: 组织 | null, 状态们: readonly 卡点状态[]): Promise<卡点行 | { ok: false; error: string }> {
  const b = await 拿卡点(tx, blockerId);
  if (!b || !(await 能看卡点(tx, me, b, org))) return 不在了;
  if (b.assigneeId !== me.id) return { ok: false as const, error: "这个卡点不在你手上，刷新看看" };
  if (!状态们.includes(b.status as 卡点状态)) return { ok: false as const, error: b.status === "已解决" ? "这个卡点已经解决了" : "这个卡点的状态变了，刷新看看" };
  return b;
}

export async function 接受卡点(me: 谁, blockerId: string): Promise<卡点结果> {
  return 写(async (tx, org) => {
    const b = await 我经手的(tx, me, blockerId, org, ["待接受"]);
    if ("ok" in b) return b;
    await tx.entBlocker.update({ where: { id: b.id }, data: { status: "处理中" } });
    await 记(tx, b.id, me.id, "accept");
    return { ok: true as const, projectId: b.projectId, code: b.code };
  });
}

/** 转让：必须选一位项目上的人（不能是自己），给那位待接受 */
export async function 转让卡点(me: 谁, blockerId: string, toUserId: string, 理由?: unknown): Promise<卡点结果> {
  return 写(async (tx, org) => {
    const b = await 我经手的(tx, me, blockerId, org, ["待接受", "处理中"]);
    if ("ok" in b) return b;
    const to = String(toUserId ?? "");
    if (!to) return { ok: false as const, error: "转让要选一位接手的人" };
    if (to === me.id) return { ok: false as const, error: "不能转让给自己" };
    if (!(await 项目上的人(tx, b.project, to))) return { ok: false as const, error: "只能转让给项目负责人或项目组成员（在职的）" };
    const note = 规整文字(理由, "转让理由");
    if (note && typeof note === "object") return { ok: false as const, error: note.error };
    await tx.entBlocker.update({ where: { id: b.id }, data: { status: "待接受", assigneeId: to } });
    await 记(tx, b.id, me.id, "transfer", { fromUserId: me.id, toUserId: to, note });
    return { ok: true as const, projectId: b.projectId, code: b.code };
  });
}

/** 返回看板：必须写理由；经手人清空，谁都能再认领 */
export async function 返回卡点(me: 谁, blockerId: string, 理由: unknown): Promise<卡点结果> {
  return 写(async (tx, org) => {
    const b = await 我经手的(tx, me, blockerId, org, ["待接受", "处理中"]);
    if ("ok" in b) return b;
    const note = typeof 理由 === "string" ? 理由.trim() : "";
    if (!note) return { ok: false as const, error: "返回看板要写一句理由" };
    if (note.length > 理由上限) return { ok: false as const, error: `理由不超过 ${理由上限} 个字` };
    await tx.entBlocker.update({ where: { id: b.id }, data: { status: "看板", assigneeId: null } });
    await 记(tx, b.id, me.id, "return", { fromUserId: me.id, note });
    return { ok: true as const, projectId: b.projectId, code: b.code };
  });
}

/** 改处理进度 / 资源申请：经手人、能管的人、发布人；已解决的不改 */
export async function 改卡点进度(me: 谁, blockerId: string, patch: { progress?: unknown; resourceRequest?: unknown }): Promise<卡点结果> {
  return 写(async (tx, org) => {
    const b = await 拿卡点(tx, blockerId);
    if (!b || !(await 能看卡点(tx, me, b, org))) return 不在了;
    if (b.assigneeId !== me.id && b.creatorId !== me.id && !能管卡点(me, b.project, org)) return { ok: false as const, error: "只有经手人、发布人、项目负责人或上级能改进度" };
    if (b.status === "已解决") return { ok: false as const, error: "这个卡点已经解决了" };
    const data: { progress?: string | null; resourceRequest?: string | null } = {};
    for (const [k, 叫法] of [["progress", "处理进度"], ["resourceRequest", "资源申请"]] as const) {
      if (patch?.[k] === undefined) continue;
      const v = 规整文字(patch[k], 叫法);
      if (v && typeof v === "object") return { ok: false as const, error: v.error };
      data[k] = v;
    }
    if (!Object.keys(data).length) return { ok: false as const, error: "要改什么？" };
    await tx.entBlocker.update({ where: { id: b.id }, data });
    await 记(tx, b.id, me.id, "progress", { note: data.progress ?? null });
    return { ok: true as const, projectId: b.projectId, code: b.code };
  });
}

/** 解决：经手人在处理中时，写解决方案和解决结果 → 已解决、记解决时间 */
export async function 解决卡点(me: 谁, blockerId: string, input: { solution?: unknown; result?: unknown }, now: Date = new Date()): Promise<卡点结果> {
  return 写(async (tx, org) => {
    const b = await 我经手的(tx, me, blockerId, org, ["处理中"]);
    if ("ok" in b) return b;
    const solution = 规整文字(input?.solution, "解决方案", true);
    if (typeof solution !== "string") return { ok: false as const, error: (solution as { error: string }).error };
    const result = 规整文字(input?.result, "解决结果", true);
    if (typeof result !== "string") return { ok: false as const, error: (result as { error: string }).error };
    await tx.entBlocker.update({ where: { id: b.id }, data: { status: "已解决", solution, result, resolvedAt: now } });
    await 记(tx, b.id, me.id, "resolve");
    return { ok: true as const, projectId: b.projectId, code: b.code };
  });
}

/**
 * 离职交接（在停用成员的事务里调）：他手上没解决的卡点——项目进公海的回看板、经手人清空（跟着项目走，领的人接着处理）；
 * 其余的转给接手人、待接受。每条记一行 handover。不是企业版什么都不做
 */
export const 离职交接理由 = "成员停用，离职交接";
export async function 交接卡点(tx: Prisma.TransactionClient, 走的人: string, 接手人: string, 操作人: string, 进公海项目: readonly string[]): Promise<number> {
  if (!企业版()) return 0;
  return 看全部(async () => {
    const 们 = await tx.entBlocker.findMany({ where: { assigneeId: 走的人, status: { in: ["待接受", "处理中"] } }, select: { id: true, projectId: true } });
    const 进公海 = new Set(进公海项目);
    for (const b of 们) {
      const 回看板 = 进公海.has(b.projectId);
      await tx.entBlocker.update({ where: { id: b.id }, data: 回看板 ? { status: "看板", assigneeId: null } : { status: "待接受", assigneeId: 接手人 } });
      await 记(tx, b.id, 操作人, "handover", { fromUserId: 走的人, toUserId: 回看板 ? null : 接手人, note: 离职交接理由 });
    }
    return 们.length;
  });
}

export type 卡点流转 = { id: string; action: string; at: Date; 谁: string; 从: string | null; 到: string | null; note: string | null };
export type 卡点视图 = {
  id: string; code: string; projectId: string; 项目: string; followUpId: string; phase: string;
  type: string; impact: string; obstacle: string; description: string; dueDays: number; dueAt: Date;
  status: string; assigneeId: string | null; 经手人: string | null; creatorId: string; 发布人: string;
  resourceRequest: string | null; progress: string | null; solution: string | null; result: string | null; resolvedAt: Date | null;
  createdAt: Date; 流转: 卡点流转[];
  /** 我在这条上能点什么 */
  能: { 认领: boolean; 指认: boolean; 接受: boolean; 转让: boolean; 返回: boolean; 解决: boolean; 改进度: boolean };
};

/** 给界面（客户端组件）的样子：日子排成字符串，不带人的 id */
export type 卡点卡 = Omit<卡点视图, "dueAt" | "resolvedAt" | "createdAt" | "流转" | "assigneeId" | "creatorId"> & {
  dueAt: string; resolvedAt: string | null; createdAt: string;
  流转: (Omit<卡点流转, "at"> & { at: string })[];
};
export function 卡点给界面(v: 卡点视图): 卡点卡 {
  const { assigneeId: _a, creatorId: _c, ...rest } = v;
  void _a; void _c;
  return {
    ...rest, dueAt: v.dueAt.toISOString(), resolvedAt: v.resolvedAt?.toISOString() ?? null, createdAt: v.createdAt.toISOString(),
    流转: v.流转.map((l) => ({ ...l, at: l.at.toISOString() })),
  };
}

async function 名字们(ids: (string | null)[]): Promise<Map<string, string>> {
  const 们 = [...new Set(ids.filter((x): x is string => !!x))];
  if (!们.length) return new Map();
  const us = await 看全部(() => prisma.user.findMany({ where: { id: { in: 们 } }, select: { id: true, name: true, email: true } }));
  return new Map(us.map((u) => [u.id, u.name || u.email]));
}

const 卡点带 = {
  project: { select: { ...项目字段, name: true } },
  logs: { orderBy: { at: "asc" as const } },
};
type 带项目卡点 = Prisma.EntBlockerGetPayload<{ include: typeof 卡点带 }>;

async function 成视图(me: 谁, 们: 带项目卡点[], org: 组织 | null): Promise<卡点视图[]> {
  const 名 = await 名字们(们.flatMap((b) => [b.assigneeId, b.creatorId, ...b.logs.flatMap((l) => [l.userId, l.fromUserId, l.toUserId])]));
  const 我在项目上 = new Map<string, boolean>();
  for (const pid of new Set(们.map((b) => b.projectId))) {
    const p = 们.find((b) => b.projectId === pid)!.project;
    我在项目上.set(pid, await 看全部(() => 项目上的人(prisma, p, me.id)));
  }
  return 们.map((b) => {
    const 经手 = b.assigneeId === me.id;
    const 管 = 能管卡点(me, b.project, org);
    const 在 = 我在项目上.get(b.projectId) === true;
    return {
      id: b.id, code: b.code, projectId: b.projectId, 项目: b.project.name, followUpId: b.followUpId, phase: b.phase,
      type: b.type, impact: b.impact, obstacle: b.obstacle, description: b.description, dueDays: b.dueDays, dueAt: b.dueAt,
      status: b.status, assigneeId: b.assigneeId, 经手人: b.assigneeId ? 名.get(b.assigneeId) ?? "—" : null,
      creatorId: b.creatorId, 发布人: 名.get(b.creatorId) ?? "—",
      resourceRequest: b.resourceRequest, progress: b.progress, solution: b.solution, result: b.result, resolvedAt: b.resolvedAt,
      createdAt: b.createdAt,
      流转: b.logs.map((l) => ({
        id: l.id, action: l.action, at: l.at, 谁: 名.get(l.userId) ?? "—",
        从: l.fromUserId ? 名.get(l.fromUserId) ?? "—" : null, 到: l.toUserId ? 名.get(l.toUserId) ?? "—" : null, note: l.note,
      })),
      能: {
        认领: b.status === "看板" && 在,
        指认: b.status === "看板" && (管 || b.creatorId === me.id),
        接受: 经手 && b.status === "待接受",
        转让: 经手 && (b.status === "待接受" || b.status === "处理中"),
        返回: 经手 && (b.status === "待接受" || b.status === "处理中"),
        解决: 经手 && b.status === "处理中",
        改进度: b.status !== "已解决" && (经手 || b.creatorId === me.id || 管),
      },
    };
  });
}

/** 项目详情里的卡点：看得到这个项目卡点的人拿全部；只是经手 / 发布的拿自己那几条；无关的人拿空 */
export async function 项目的卡点(me: 谁, projectId: string): Promise<卡点视图[]> {
  if (!企业版()) return [];
  const org = await 组织of();
  return 看全部(async () => {
    const p = await prisma.project.findUnique({ where: { id: String(projectId ?? "") }, select: 项目字段 });
    if (!p) return [];
    const 全 = await 能看项目卡点(prisma, me, p, org);
    const 们 = await prisma.entBlocker.findMany({
      where: { projectId: p.id, ...(全 ? {} : { OR: [{ assigneeId: me.id }, { creatorId: me.id }] }) },
      include: 卡点带, orderBy: { createdAt: "desc" },
    });
    return 成视图(me, 们, org);
  });
}

/**
 * 我的卡点看板：指给我的（待接受、处理中），加上我是项目上的人的项目里、看板上没人接的
 */
export async function 我的卡点(me: 谁): Promise<卡点视图[]> {
  if (!企业版()) return [];
  const org = await 组织of();
  return 看全部(async () => {
    const 组 = await prisma.projectMember.findMany({ where: { userId: me.id, inviteStatus: "JOINED" }, select: { projectId: true } });
    const 们 = await prisma.entBlocker.findMany({
      where: {
        OR: [
          { assigneeId: me.id, status: { in: ["待接受", "处理中"] } },
          { status: "看板", project: { pooledAt: null, OR: [{ ownerId: me.id }, { id: { in: 组.map((m) => m.projectId) } }] } },
        ],
      },
      include: 卡点带, orderBy: { dueAt: "asc" },
    });
    return 成视图(me, 们, org);
  });
}

/** 项目详情要不要给「发卡点」按钮：和 发布卡点 同一个判断（不在公海；能管的或点了同意的组员） */
export async function 能发卡点(me: 谁, projectId: string): Promise<boolean> {
  if (!企业版()) return false;
  const org = await 组织of();
  return 看全部(async () => {
    const p = await prisma.project.findUnique({ where: { id: String(projectId ?? "") }, select: 项目字段 });
    if (!p || p.pooledAt) return false;
    return 能管卡点(me, p, org) || 是组员(prisma, p.id, me.id);
  });
}

/** 项目上能被指认 / 转让的人（在职负责人 + 点了同意的组员），给界面下拉用 */
export async function 卡点可选的人(me: 谁, projectId: string): Promise<{ id: string; name: string }[]> {
  if (!企业版()) return [];
  const org = await 组织of();
  return 看全部(async () => {
    const p = await prisma.project.findUnique({ where: { id: String(projectId ?? "") }, select: 项目字段 });
    if (!p || !(await 能看项目卡点(prisma, me, p, org))) return [];
    const 组 = await prisma.projectMember.findMany({ where: { projectId: p.id, inviteStatus: "JOINED" }, select: { userId: true } });
    const ids = [...new Set([...(p.pooledAt ? [] : [p.ownerId]), ...组.map((m) => m.userId)])];
    const us = await prisma.user.findMany({ where: { id: { in: ids }, active: true }, select: { id: true, name: true, email: true }, orderBy: { name: "asc" } });
    return us.map((u) => ({ id: u.id, name: u.name || u.email }));
  });
}

/** 项目详情里每条沟通的编号和下一步时间（不是企业版给空的） */
export async function 沟通编号们(followUpIds: string[]): Promise<Map<string, { code: string; nextAt: Date | null }>> {
  if (!企业版() || !followUpIds.length) return new Map();
  const 们 = await prisma.entFollowUpMeta.findMany({ where: { followUpId: { in: followUpIds } }, select: { followUpId: true, code: true, nextAt: true } });
  return new Map(们.map((m) => [m.followUpId, { code: m.code, nextAt: m.nextAt }]));
}
