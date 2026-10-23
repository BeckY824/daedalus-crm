/**
 * 团队版项目模式 1a 的读写（2026-10-23，D-31）。取值规矩在 lib/project/nodes.ts，界面的写在 app/(app)/projects/actions.ts。
 * 这里不管登录、不管开关，只管「谁能改」和「改了留什么痕」，方便单测直接调。
 */
import type { Prisma } from "@/generated/prisma";
import { prisma } from "../prisma";
import { 查完再写 } from "../check-then-write";
import { 改节点问题, 原因上限, type 位置 } from "./nodes";

type 谁 = { id: string; role: string };
type 结果 = { ok: true } | { ok: false; error: string };

/** 组员角色字典的默认 4 个。字典空着时第一次读顺手建上（迁移只建表、不写数据） */
export const 默认角色们 = ["产品研发", "售后", "商务方案", "项目经理"] as const;
export const 角色名上限 = 20;

/**
 * 能改这个项目（节点、尾款 / 验收、负责人）：项目负责人本人、老板、业务主管。
 * 业务员看得到同事客户下的项目（互看）也只是看
 */
export function 能管项目(me: 谁, p: { ownerId: string }): boolean {
  return me.id === p.ownerId || me.role === "ADMIN" || me.role === "MANAGER";
}

/** 组员角色字典：按排序列出（停用的也列，界面自己挑），空着就先建默认 4 个 */
export async function 角色字典(db: Prisma.TransactionClient = prisma) {
  if ((await db.projectRole.count()) === 0) {
    // 两个窗口同时第一次读：按名字 upsert，后到的那个什么都不改
    for (const [i, name] of 默认角色们.entries()) {
      await db.projectRole.upsert({ where: { name }, update: {}, create: { name, sort: i } });
    }
  }
  return db.projectRole.findMany({ orderBy: [{ sort: "asc" }, { createdAt: "asc" }] });
}

function 规整角色名(name: unknown): string | { error: string } {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n) return { error: "角色名不能空着" };
  if (n.length > 角色名上限) return { error: `角色名请控制在 ${角色名上限} 字以内` };
  return n;
}

/** 加一个角色，排在最后。只有老板能改字典（和项目模式开关同一条规矩） */
export async function 加角色(me: 谁, name: unknown): Promise<结果 & { id?: string }> {
  if (me.role !== "ADMIN") return { ok: false, error: "组员角色只有老板能改" };
  const n = 规整角色名(name);
  if (typeof n !== "string") return { ok: false, ...n };
  return 查完再写(async (tx) => {
    const 有 = await tx.projectRole.findUnique({ where: { name: n } });
    // 停用过的同名角色：重新启用，已经用它的组员接着认
    if (有) {
      if (有.active) return { ok: false as const, error: `已经有「${n}」这个角色了` };
      await tx.projectRole.update({ where: { id: 有.id }, data: { active: true } });
      return { ok: true as const, id: 有.id };
    }
    const 末 = await tx.projectRole.aggregate({ _max: { sort: true } });
    const r = await tx.projectRole.create({ data: { name: n, sort: (末._max.sort ?? -1) + 1 } });
    return { ok: true as const, id: r.id };
  });
}

/** 改角色名 / 停用 / 启用。不删：删了的只停用，已经用它的组员不丢 */
export async function 改角色(me: 谁, id: string, patch: { name?: unknown; active?: boolean }): Promise<结果> {
  if (me.role !== "ADMIN") return { ok: false, error: "组员角色只有老板能改" };
  const data: { name?: string; active?: boolean } = {};
  if (patch.name !== undefined) {
    const n = 规整角色名(patch.name);
    if (typeof n !== "string") return { ok: false, ...n };
    data.name = n;
  }
  if (patch.active !== undefined) data.active = patch.active === true;
  return 查完再写(async (tx) => {
    const r = await tx.projectRole.findUnique({ where: { id: String(id ?? "") } });
    if (!r) return { ok: false as const, error: "这个角色已经不在了，刷新看看" };
    if (data.name && data.name !== r.name && (await tx.projectRole.findUnique({ where: { name: data.name } }))) {
      return { ok: false as const, error: `已经有「${data.name}」这个角色了` };
    }
    await tx.projectRole.update({ where: { id: r.id }, data });
    return { ok: true as const };
  });
}

/**
 * 改节点：前后随意、跨阶段也行，点结局也走这里。每改一次记一行 ProjectNodeLog。
 * 有结局记下 closedAt，回到进行中（= 从异常状态恢复、从丢单捡回来）清掉；异常原因只在异常状态时留在项目上，节点变更里永远留着
 */
export async function 改节点(me: 谁, projectId: string, 到: 位置, 原因?: string | null): Promise<结果 & { 变了?: boolean }> {
  return 查完再写(async (tx) => {
    const p = await tx.project.findUnique({ where: { id: String(projectId ?? "") } });
    if (!p) return { ok: false as const, error: "这个项目已经不在了，刷新看看" };
    if (!能管项目(me, p)) return { ok: false as const, error: "只有项目负责人、老板或主管能改节点" };
    const result = 到.result || null;
    const 问题 = 改节点问题({ ...到, result }, p, 原因);
    if (问题) return { ok: false as const, error: 问题 };
    const 理由 = result === "异常状态" ? (原因 ?? "").trim().slice(0, 原因上限) : null;
    if (p.phase === 到.phase && p.node === 到.node && p.result === result && (p.exceptionReason ?? null) === 理由) {
      return { ok: true as const, 变了: false };
    }
    await tx.project.update({
      where: { id: p.id },
      data: {
        phase: 到.phase, node: 到.node, result, exceptionReason: 理由,
        closedAt: result ? (p.result === result ? p.closedAt : new Date()) : null,
      },
    });
    await tx.projectNodeLog.create({
      data: {
        projectId: p.id, userId: me.id,
        fromPhase: p.phase, fromNode: p.node, fromResult: p.result,
        toPhase: 到.phase, toNode: 到.node, toResult: result, reason: 理由,
      },
    });
    return { ok: true as const, 变了: true };
  });
}

export const 交付项们 = { balanceSettled: "尾款结清", acceptancePassed: "验收通过" } as const;
export type 交付项 = keyof typeof 交付项们;

/** 勾 / 取消尾款结清、验收通过，记谁、何时。已经成功交付的不让取消（先把节点改回去） */
export async function 勾交付(me: 谁, projectId: string, 项: 交付项, 勾: boolean): Promise<结果 & { 变了?: boolean }> {
  if (!(项 in 交付项们)) return { ok: false, error: "没有这一项" };
  return 查完再写(async (tx) => {
    const p = await tx.project.findUnique({ where: { id: String(projectId ?? "") } });
    if (!p) return { ok: false as const, error: "这个项目已经不在了，刷新看看" };
    if (!能管项目(me, p)) return { ok: false as const, error: "只有项目负责人、老板或主管能勾" };
    if (p[项] === 勾) return { ok: true as const, 变了: false };
    if (!勾 && p.result === "成功交付") return { ok: false as const, error: `已经成功交付了；要取消「${交付项们[项]}」，先把节点改回去` };
    const 谁勾 = 项 === "balanceSettled" ? { balanceSettledById: 勾 ? me.id : null, balanceSettledAt: 勾 ? new Date() : null } : { acceptancePassedById: 勾 ? me.id : null, acceptancePassedAt: 勾 ? new Date() : null };
    await tx.project.update({ where: { id: p.id }, data: { [项]: 勾, ...谁勾 } });
    return { ok: true as const, 变了: true };
  });
}

/**
 * 删项目：负责人、老板、主管。节点变更、组员、跟进挂的节点随项目级联；跟进本身留在客户下。
 * 删客户前要先删光它的项目（customers/actions 删除依赖错误）
 */
export async function 删项目(me: 谁, projectId: string): Promise<结果 & { name?: string; customerId?: string }> {
  return 查完再写(async (tx) => {
    const p = await tx.project.findUnique({ where: { id: String(projectId ?? "") }, select: { id: true, name: true, ownerId: true, customerId: true } });
    if (!p) return { ok: false as const, error: "这个项目已经不在了，刷新看看" };
    if (!能管项目(me, p)) return { ok: false as const, error: "只有项目负责人、老板或主管能删项目" };
    await tx.project.delete({ where: { id: p.id } });
    return { ok: true as const, name: p.name, customerId: p.customerId };
  });
}

/** 这位客户名下还有几个项目（删客户前问：有项目的先删项目） */
export async function 客户的项目数(customerIds: string[], db: Prisma.TransactionClient = prisma): Promise<Map<string, number>> {
  if (!customerIds.length) return new Map();
  const rows = await db.project.groupBy({ by: ["customerId"], where: { customerId: { in: customerIds } }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.customerId, r._count._all]));
}
