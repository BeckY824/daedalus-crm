/**
 * 团队版项目模式 1a 的读写（2026-10-23，D-31）。取值规矩在 lib/project/nodes.ts，界面的写在 app/(app)/projects/actions.ts。
 * 这里不管登录、不管开关，只管「谁能改」和「改了留什么痕」，方便单测直接调。
 */
import type { Prisma } from "@/generated/prisma";
import { prisma } from "../prisma";
import { 查完再写 } from "../check-then-write";
import { 改节点问题, 原因上限, type 位置 } from "./nodes";
import { 规整项目, type 向导项目 } from "./wizard";

type 谁 = { id: string; role: string };
type 结果 = { ok: true } | { ok: false; error: string };

/** 组员角色字典的默认 4 个。字典空着时第一次读顺手建上（迁移只建表、不写数据） */
export const 默认角色们 = ["产品研发", "售后", "商务方案", "项目经理"] as const;
/** 默认 4 个角色的固定 id：每台机器建出来的一样，团队版同步（1b）按 id 对得上 */
export const 默认角色id: Record<(typeof 默认角色们)[number], string> = { 产品研发: "rd", 售后: "after-sales", 商务方案: "solution", 项目经理: "pm" };
export const 角色名上限 = 20;

/**
 * 能改这个项目（节点、尾款 / 验收、负责人）：项目负责人本人、老板、业务主管。
 * 业务员看得到同事客户下的项目（互看）也只是看。
 * 在公海里的项目没有负责人：放回去的人也不能再改，只有老板、主管能动；其他人要改先领取
 */
export function 能管项目(me: 谁, p: { ownerId: string; pooledAt?: Date | null }): boolean {
  if (me.role === "ADMIN" || me.role === "MANAGER") return true;
  return !p.pooledAt && me.id === p.ownerId;
}

/**
 * 项目公海里的项目谁都看得到（才能领），但客户可能是同事的：客户名、公司、联系人、沟通内容这时都不给，
 * 领了（成了负责人）再看（质量审 10-23）。看得到这位客户（自己的、客户公海里的、老板 / 主管、开了互看）照常给
 */
export function 露客户(me: { id: string }, p: { customerId: string; ownerId: string; pooledAt?: Date | null }, 看得到的: ReadonlySet<string>): boolean {
  return 看得到的.has(p.customerId) || (!p.pooledAt && p.ownerId === me.id);
}

/** 这批客户里当前这位看得到哪几个：走带限定的客户端查一遍，限定层说了算，这里不另写一套规矩 */
export async function 看得到的客户(customerIds: string[], db: Pick<Prisma.TransactionClient, "customer"> = prisma): Promise<Set<string>> {
  const ids = [...new Set(customerIds)];
  if (ids.length === 0) return new Set();
  const rows = await db.customer.findMany({ where: { id: { in: ids } }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/** 组员角色字典：按排序列出（停用的也列，界面自己挑），空着就先建默认 4 个 */
export async function 角色字典(db: Prisma.TransactionClient = prisma) {
  if ((await db.projectRole.count()) === 0) {
    // 两个窗口同时第一次读：按名字 upsert，后到的那个什么都不改
    for (const [i, name] of 默认角色们.entries()) {
      await db.projectRole.upsert({ where: { name }, update: {}, create: { id: 默认角色id[name], name, sort: i } });
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

/** 异常类别字典的默认 2 个，固定 id 同角色字典（团队版同步按 id 对得上）。字典空着时第一次读顺手建上 */
export const 默认异常类别们 = ["纠纷取消", "项目停滞"] as const;
export const 默认异常类别id: Record<(typeof 默认异常类别们)[number], string> = { 纠纷取消: "dispute-cancel", 项目停滞: "stalled" };

/** 异常类别字典：按排序列出（停用的也列，界面自己挑），空着就先建默认 2 个 */
export async function 异常类别字典(db: Prisma.TransactionClient = prisma) {
  if ((await db.projectExceptionCategory.count()) === 0) {
    for (const [i, name] of 默认异常类别们.entries()) {
      await db.projectExceptionCategory.upsert({ where: { name }, update: {}, create: { id: 默认异常类别id[name], name, sort: i } });
    }
  }
  return db.projectExceptionCategory.findMany({ orderBy: [{ sort: "asc" }, { createdAt: "asc" }] });
}

function 规整类别名(name: unknown): string | { error: string } {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n) return { error: "类别名不能空着" };
  if (n.length > 角色名上限) return { error: `类别名请控制在 ${角色名上限} 字以内` };
  return n;
}

/** 加一个异常类别，排在最后。只有老板能改字典；停用过的同名类别重新启用 */
export async function 加异常类别(me: 谁, name: unknown): Promise<结果 & { id?: string }> {
  if (me.role !== "ADMIN") return { ok: false, error: "异常类别只有老板能改" };
  const n = 规整类别名(name);
  if (typeof n !== "string") return { ok: false, ...n };
  return 查完再写(async (tx) => {
    const 有 = await tx.projectExceptionCategory.findUnique({ where: { name: n } });
    if (有) {
      if (有.active) return { ok: false as const, error: `已经有「${n}」这个类别了` };
      await tx.projectExceptionCategory.update({ where: { id: 有.id }, data: { active: true } });
      return { ok: true as const, id: 有.id };
    }
    const 末 = await tx.projectExceptionCategory.aggregate({ _max: { sort: true } });
    const r = await tx.projectExceptionCategory.create({ data: { name: n, sort: (末._max.sort ?? -1) + 1 } });
    return { ok: true as const, id: r.id };
  });
}

/** 改类别名 / 停用 / 启用。不删：停用的不能再选，已经在用它的项目不丢 */
export async function 改异常类别(me: 谁, id: string, patch: { name?: unknown; active?: boolean }): Promise<结果> {
  if (me.role !== "ADMIN") return { ok: false, error: "异常类别只有老板能改" };
  const data: { name?: string; active?: boolean } = {};
  if (patch.name !== undefined) {
    const n = 规整类别名(patch.name);
    if (typeof n !== "string") return { ok: false, ...n };
    data.name = n;
  }
  if (patch.active !== undefined) data.active = patch.active === true;
  return 查完再写(async (tx) => {
    const r = await tx.projectExceptionCategory.findUnique({ where: { id: String(id ?? "") } });
    if (!r) return { ok: false as const, error: "这个类别已经不在了，刷新看看" };
    if (data.name && data.name !== r.name && (await tx.projectExceptionCategory.findUnique({ where: { name: data.name } }))) {
      return { ok: false as const, error: `已经有「${data.name}」这个类别了` };
    }
    await tx.projectExceptionCategory.update({ where: { id: r.id }, data });
    return { ok: true as const };
  });
}

/**
 * 改节点：往前只能一步一步走，往后随便退（nodes.ts 改节点问题），点结局也走这里。每改一次记一行 ProjectNodeLog。
 * 有结局记下 closedAt，回到进行中（= 从异常状态恢复、从丢单捡回来）清掉。
 * 进异常状态要选一个在用的异常类别，备注可空；类别和备注只在异常状态时留在项目上，节点变更里永远留着
 */
export async function 改节点(
  me: 谁, projectId: string, 到: 位置, 异常?: { categoryId?: string | null; 备注?: string | null },
): Promise<结果 & { 变了?: boolean }> {
  return 查完再写(async (tx) => {
    const p = await tx.project.findUnique({ where: { id: String(projectId ?? "") } });
    if (!p) return { ok: false as const, error: "这个项目已经不在了，刷新看看" };
    if (!能管项目(me, p)) return { ok: false as const, error: p.pooledAt ? "这个项目在公海里，先领取再改" : "只有项目负责人、老板或主管能改节点" };
    const result = 到.result || null;
    const 问题 = 改节点问题({ ...到, result }, p, 异常);
    if (问题) return { ok: false as const, error: 问题 };
    let 类别: string | null = null;
    let 备注: string | null = null;
    if (result === "异常状态") {
      类别 = String(异常?.categoryId);
      // 已经在用的类别停用了也能留着（只改备注）；换成的得是在用的
      if (类别 !== p.exceptionCategoryId) {
        const c = await tx.projectExceptionCategory.findUnique({ where: { id: 类别 } });
        if (!c) return { ok: false as const, error: "这个异常类别已经不在了，刷新看看" };
        if (!c.active) return { ok: false as const, error: `「${c.name}」已经停用了，换一个` };
      }
      备注 = (异常?.备注 ?? "").trim().slice(0, 原因上限) || null;
    }
    if (p.phase === 到.phase && p.node === 到.node && p.result === result && p.exceptionCategoryId === 类别 && (p.exceptionReason ?? null) === 备注) {
      return { ok: true as const, 变了: false };
    }
    await tx.project.update({
      where: { id: p.id },
      data: {
        phase: 到.phase, node: 到.node, result, exceptionCategoryId: 类别, exceptionReason: 备注,
        closedAt: result ? (p.result === result ? p.closedAt : new Date()) : null,
      },
    });
    await tx.projectNodeLog.create({
      data: {
        projectId: p.id, userId: me.id,
        fromPhase: p.phase, fromNode: p.node, fromResult: p.result,
        toPhase: 到.phase, toNode: 到.node, toResult: result, categoryId: 类别, reason: 备注,
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
    const p = await tx.project.findUnique({ where: { id: String(projectId ?? "") }, select: { id: true, name: true, ownerId: true, pooledAt: true, customerId: true } });
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

/**
 * 转让负责人留一行痕：和改节点同一张表，kind = transfer；节点没动，from / to 节点照抄当时的。
 * 手动转让（改项目）和客户转让带着走（carry-over-db）都走这里；放回公海、从公海领取也走这里，kind 换成 pool-release / pool-claim
 */
export async function 记转让(
  tx: Prisma.TransactionClient,
  p: { id: string; phase: string; node: string; result: string | null },
  操作人: string, 从: string | null, 到: string | null,
  kind: "transfer" | "pool-release" | "pool-claim" = "transfer",
) {
  await tx.projectNodeLog.create({
    data: {
      projectId: p.id, userId: 操作人, kind, fromOwnerId: 从, toOwnerId: 到,
      fromPhase: p.phase, fromNode: p.node, fromResult: p.result,
      toPhase: p.phase, toNode: p.node, toResult: p.result,
    },
  });
}

/** 负责人、上级、组员都得是在职成员 */
async function 在职(tx: Prisma.TransactionClient, userId: string) {
  return (await tx.user.findUnique({ where: { id: userId }, select: { active: true } }))?.active === true;
}

/**
 * 编辑项目：名称、负责人、金额 + 币种、备注、主联系人。规矩同向导第四步（规整项目）；
 * 负责人得在职，主联系人得是这位客户的。节点、交付两项不走这里。
 * 换负责人 = 转让：能管项目的人（负责人本人、老板、主管）能转，只改这一个项目，记谁、何时、从谁到谁。
 * 公海里的项目老板 / 主管指了新负责人 = 出公海。建档人（creatorId）不在这里、哪里都不给改
 */
export async function 改项目(me: 谁, projectId: string, patch: 向导项目 & { contactId?: string | null }): Promise<结果 & { 变了?: string[] }> {
  if (!patch || typeof patch !== "object") return { ok: false, error: "要改什么？" };
  return 查完再写(async (tx) => {
    const p = await tx.project.findUnique({ where: { id: String(projectId ?? "") } });
    if (!p) return { ok: false as const, error: "这个项目已经不在了，刷新看看" };
    if (!能管项目(me, p)) return { ok: false as const, error: p.pooledAt ? "这个项目在公海里，先领取再改" : "只有项目负责人、老板或主管能改" };
    const 好 = 规整项目(patch, p.ownerId);
    if ("error" in 好) return { ok: false as const, error: 好.error };
    if (好.ownerId !== p.ownerId && !(await 在职(tx, 好.ownerId))) return { ok: false as const, error: "项目负责人不存在或已停用，请选一位在职成员" };
    const contactId = patch.contactId === undefined ? p.contactId : patch.contactId || null;
    if (contactId && contactId !== p.contactId) {
      const c = await tx.contact.findUnique({ where: { id: contactId }, select: { customerId: true } });
      if (c?.customerId !== p.customerId) return { ok: false as const, error: "这位联系人不在这个客户下，刷新看看" };
    }
    const 新 = { ...好, contactId };
    const 变了 = (Object.keys(新) as (keyof typeof 新)[]).filter((k) => 新[k] !== p[k]);
    if (!变了.length) return { ok: true as const, 变了 };
    const 换人 = 新.ownerId !== p.ownerId;
    await tx.project.update({ where: { id: p.id }, data: { ...新, ...(换人 && p.pooledAt ? { pooledAt: null } : {}) } });
    if (换人) await 记转让(tx, p, me.id, p.ownerId, 新.ownerId);
    return { ok: true as const, 变了 };
  });
}

/** 能进公海的阶段：线索、商机；订单阶段不能放 */
export const 能进公海的阶段 = ["线索", "商机"] as const;

/**
 * 放回公海：只有负责人本人能放，线索 / 商机阶段才行。ownerId 留着放回去的人（他不能自己领回），
 * 记一行 pool-release。项目组、节点、交付两项都不动
 */
export async function 放回公海(me: 谁, projectId: string): Promise<结果> {
  return 查完再写(async (tx) => {
    const p = await tx.project.findUnique({ where: { id: String(projectId ?? "") } });
    if (!p) return { ok: false as const, error: "这个项目已经不在了，刷新看看" };
    if (p.pooledAt) return { ok: false as const, error: "这个项目已经在公海里了" };
    if (me.id !== p.ownerId) return { ok: false as const, error: "只有项目负责人能放回公海" };
    if (!(能进公海的阶段 as readonly string[]).includes(p.phase)) return { ok: false as const, error: "订单阶段的项目不能放回公海" };
    await tx.project.update({ where: { id: p.id }, data: { pooledAt: new Date() } });
    await 记转让(tx, p, me.id, p.ownerId, null, "pool-release");
    return { ok: true as const };
  });
}

/** 从公海领取：除了放回去的那位，谁都能领；领了就是新负责人，记一行 pool-claim */
export async function 领取公海项目(me: 谁, projectId: string): Promise<结果> {
  return 查完再写(async (tx) => {
    const p = await tx.project.findUnique({ where: { id: String(projectId ?? "") } });
    if (!p) return { ok: false as const, error: "这个项目已经不在了，刷新看看" };
    if (!p.pooledAt) return { ok: false as const, error: "这个项目已经被人领走了，刷新看看" };
    if (me.id === p.ownerId) return { ok: false as const, error: "自己放回公海的项目不能自己领回" };
    if (!(await 在职(tx, me.id))) return { ok: false as const, error: "账号已停用" };
    await tx.project.update({ where: { id: p.id }, data: { ownerId: me.id, pooledAt: null } });
    await 记转让(tx, p, me.id, p.ownerId, me.id, "pool-claim");
    return { ok: true as const };
  });
}

/**
 * 公海超时自动收回：先不做（10-23 定：只留口子，规则等会上定）。
 * 定了以后在这里填规则（比如几天没推节点 / 没跟进），定时任务调 公海超时收回()，逐个走和 放回公海 一样的留痕。
 * 现在规则是 null，调了什么都不做
 */
export const 公海超时规则: { 天数: number } | null = null;
export function 公海超时收回(): number {
  return 0;
}

/**
 * 加组员：能管项目的人拉，1a 直接进组（inviteStatus = JOINED）；1b 的进组邀请改成 INVITED、等对方点。
 * 角色可空；停用的角色不让新选，已经用它的组员不动
 */
export async function 加组员(me: 谁, projectId: string, userId: string, roleId?: string | null): Promise<结果> {
  return 查完再写(async (tx) => {
    const p = await tx.project.findUnique({ where: { id: String(projectId ?? "") }, select: { id: true, ownerId: true, pooledAt: true } });
    if (!p) return { ok: false as const, error: "这个项目已经不在了，刷新看看" };
    if (!能管项目(me, p)) return { ok: false as const, error: "只有项目负责人、老板或主管能加组员" };
    const uid = String(userId ?? "");
    if (!(await 在职(tx, uid))) return { ok: false as const, error: "这位成员不存在或已停用" };
    const 角色 = await 可用角色(tx, roleId);
    if (typeof 角色 === "object" && 角色) return 角色;
    if (await tx.projectMember.findUnique({ where: { projectId_userId: { projectId: p.id, userId: uid } } })) {
      return { ok: false as const, error: "这位已经在项目组里了" };
    }
    await tx.projectMember.create({ data: { projectId: p.id, userId: uid, roleId: 角色, inviteStatus: "JOINED", invitedById: me.id } });
    return { ok: true as const };
  });
}

/** 角色 id → 能用的角色 id（null = 不选）；停用的、不在的给一句话 */
async function 可用角色(tx: Prisma.TransactionClient, roleId: string | null | undefined): Promise<string | null | { ok: false; error: string }> {
  if (!roleId) return null;
  const r = await tx.projectRole.findUnique({ where: { id: String(roleId) } });
  if (!r) return { ok: false, error: "这个角色已经不在了，刷新看看" };
  if (!r.active) return { ok: false, error: `「${r.name}」已经停用了，换一个` };
  return r.id;
}

/** 换组员的角色。原来那个停用了也能换走；换成的得是在用的 */
export async function 换组员角色(me: 谁, memberId: string, roleId: string | null): Promise<结果> {
  return 查完再写(async (tx) => {
    const m = await tx.projectMember.findUnique({ where: { id: String(memberId ?? "") }, include: { project: { select: { ownerId: true, pooledAt: true } } } });
    if (!m) return { ok: false as const, error: "这位已经不在项目组里了，刷新看看" };
    if (!能管项目(me, m.project)) return { ok: false as const, error: "只有项目负责人、老板或主管能改组员" };
    if ((roleId || null) === m.roleId) return { ok: true as const };
    const 角色 = await 可用角色(tx, roleId);
    if (typeof 角色 === "object" && 角色) return 角色;
    await tx.projectMember.update({ where: { id: m.id }, data: { roleId: 角色 } });
    return { ok: true as const };
  });
}

/** 移出项目组 */
export async function 移出组员(me: 谁, memberId: string): Promise<结果> {
  return 查完再写(async (tx) => {
    const m = await tx.projectMember.findUnique({ where: { id: String(memberId ?? "") }, include: { project: { select: { ownerId: true, pooledAt: true } } } });
    if (!m) return { ok: true as const };
    if (!能管项目(me, m.project)) return { ok: false as const, error: "只有项目负责人、老板或主管能改组员" };
    await tx.projectMember.delete({ where: { id: m.id } });
    return { ok: true as const };
  });
}
