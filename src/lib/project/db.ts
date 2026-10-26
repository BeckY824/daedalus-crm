/**
 * 团队版项目模式 1a 的读写（2026-10-23，D-31）。取值规矩在 lib/project/nodes.ts，界面的写在 app/(app)/projects/actions.ts。
 * 这里不管登录、不管开关，只管「谁能改」和「改了留什么痕」，方便单测直接调。
 */
import type { Prisma } from "@/generated/prisma";
import { prisma } from "../prisma";
import { 查完再写 } from "../check-then-write";
import { 改节点问题, 原因上限, 要写原因, 下一步, 节点序号, type 位置 } from "./nodes";
import { 还差, 必填叫法, 节点推进生效, 按必填走, 节点必填, type 必填数据 } from "./required";
import { 规整项目, 规整沟通, type 向导项目, type 向导跟进 } from "./wizard";
import { 持有上限of, type 组织规则 } from "./org-rules";
import { 企业版 } from "@/lib/enterprise/switch";
import { 读组织, 直属上级of, 管理员类别of, type 组织 } from "@/lib/enterprise/org";
import { 规则开着 } from "@/lib/enterprise/rules";
import { 挡改设置 } from "@/lib/enterprise/edit-perm";
import { 生效组织规则 } from "./org-rules-store";
import { 超时回收日, 已超时, 超时理由, 超时起点 } from "./timeout";
import { getSetting, setSetting } from "../settings";
import { recordAudit } from "../audit";
import { 读团队 } from "../sync/client";
import { dayjs } from "../utils";
import { 看全部 } from "../team-scope";

type 谁 = { id: string; role: string };
type 结果 = { ok: true } | { ok: false; error: string };

/** 组员角色字典的默认 4 个。字典空着时第一次读顺手建上（迁移只建表、不写数据） */
export const 默认角色们 = ["产品研发", "售后", "商务方案", "项目经理"] as const;
/** 默认 4 个角色的固定 id：每台机器建出来的一样，团队版同步（1b）按 id 对得上 */
export const 默认角色id: Record<(typeof 默认角色们)[number], string> = { 产品研发: "rd", 售后: "after-sales", 商务方案: "solution", 项目经理: "pm" };
/** 企业版的组员角色多两个（10-26 用户定 6 个）：字典里没有就补上，固定 id 同上；字典照旧能改、能停用 */
export const 企业版加的角色: Record<string, string> = { 采购: "purchase", 跟单: "merch" };
export const 角色名上限 = 20;

/**
 * 能改这个项目（节点、尾款 / 验收、负责人）：项目负责人本人、老板、业务主管。
 * 业务员看得到同事客户下的项目（互看）也只是看。
 * 在公海里的项目没有负责人：只有老板、主管能动；其他人（放回去的那位也一样）要改先领取
 */
export function 能管项目(me: 谁, p: { ownerId: string; pooledAt?: Date | null }): boolean {
  if (me.role === "ADMIN" || me.role === "MANAGER") return true;
  return !p.pooledAt && me.id === p.ownerId;
}

/**
 * 企业版 D-37：负责人的直属上级、组织里的总管理员能改这个项目的节点。组织里设的角色不会改账号角色，
 * 直属上级可能还是 SALES，光看 能管项目 会把他拦在外面（质量审 #138）。org = null（不是企业版）→ 和 能管项目 一样
 */
export function 能改节点(me: 谁, p: { ownerId: string; pooledAt?: Date | null }, org: 组织 | null): boolean {
  return 能管项目(me, p) || (!p.pooledAt && 代管节点(me, p.ownerId, org));
}
/** 企业版：负责人的直属上级，或组织里的总管理员（10-24 用户定：总管理员能推，和老板一样） */
export function 代管节点(me: 谁, ownerId: string, org: 组织 | null): boolean {
  return !!org && (直属上级of(org, ownerId) === me.id || 管理员类别of(org, me.id) === "总管理员");
}

/**
 * 企业版 D-37：负责人有直属上级时，手动往前推节点只给这位直属上级、老板和组织里的总管理员；负责人本人、隔级上级、
 * 虚线上级（D-39 只读）都不行，本人填齐必填照样自动推。往后退、点结局、进异常不归这条管。
 * 负责人没设直属上级（组织还没配）照旧，免得谁都推不动。org = null（不是企业版）→ 不拦。
 * 返回拦下的话，null = 能推
 */
/**
 * 「直属才能推」跟「按组织架构看客户」开关走（F10，10-25 实测）：开关关着就是团队版，谁的项目谁推，
 * 往前推不给 拿到 null。直属上级能改节点、能代管必填（能改节点 / 代管节点）不跟这个开关，照旧给
 */
export async function 直属才推(org: 组织 | null): Promise<组织 | null> {
  return org && (await 规则开着("按组织看客户")) ? org : null;
}

export function 往前推不给(me: 谁, ownerId: string, org: 组织 | null): string | null {
  if (!org) return null;
  const 上级 = 直属上级of(org, ownerId);
  if (!上级 || me.id === 上级 || me.role === "ADMIN" || 管理员类别of(org, me.id) === "总管理员") return null;
  return me.id === ownerId ? "往前推节点要由你的直属上级来推" : "只有负责人的直属上级能往前推节点";
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

/** 组员角色字典：按排序列出（停用的也列，界面自己挑），空着就先建默认 4 个；企业版再补采购、跟单 */
export async function 角色字典(db: Prisma.TransactionClient = prisma) {
  if ((await db.projectRole.count()) === 0) {
    // 两个窗口同时第一次读：按名字 upsert，后到的那个什么都不改
    for (const [i, name] of 默认角色们.entries()) {
      await db.projectRole.upsert({ where: { name }, update: {}, create: { id: 默认角色id[name], name, sort: i } });
    }
  }
  if (企业版()) {
    // 角色只停用不删：按 id 或名字有过的（改了名、停用了的）都不再补
    const 有了 = await db.projectRole.findMany({ where: { OR: [{ id: { in: Object.values(企业版加的角色) } }, { name: { in: Object.keys(企业版加的角色) } }] }, select: { id: true, name: true } });
    const 排到 = await db.projectRole.count();
    let i = 0;
    for (const [name, id] of Object.entries(企业版加的角色)) {
      if (有了.some((r) => r.id === id || r.name === name)) continue;
      await db.projectRole.upsert({ where: { name }, update: {}, create: { id, name, sort: 排到 + i++ } });
    }
  }
  return db.projectRole.findMany({ orderBy: [{ sort: "asc" }, { createdAt: "asc" }] });
}

/**
 * 两本字典谁能改：不是企业版只有老板（和项目模式开关同一条规矩）；
 * 企业版按「后台设置谁能改」的「异常类别、组员角色字典」一行，默认老板和总管理员（B2 第 6 条，10-26）
 */
async function 挡字典(me: 谁, 叫法: string): Promise<string | null> {
  const 挡 = await 挡改设置(me, "字典");
  return 挡 && `${叫法}${挡}`;
}

function 规整角色名(name: unknown): string | { error: string } {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n) return { error: "角色名不能空着" };
  if (n.length > 角色名上限) return { error: `角色名请控制在 ${角色名上限} 字以内` };
  return n;
}

/** 加一个角色，排在最后。谁能改见 挡字典 */
export async function 加角色(me: 谁, name: unknown): Promise<结果 & { id?: string }> {
  const 挡 = await 挡字典(me, "组员角色");
  if (挡) return { ok: false, error: 挡 };
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
  const 挡 = await 挡字典(me, "组员角色");
  if (挡) return { ok: false, error: 挡 };
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

/** 加一个异常类别，排在最后。谁能改见 挡字典；停用过的同名类别重新启用 */
export async function 加异常类别(me: 谁, name: unknown): Promise<结果 & { id?: string }> {
  const 挡 = await 挡字典(me, "异常类别");
  if (挡) return { ok: false, error: 挡 };
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
  const 挡 = await 挡字典(me, "异常类别");
  if (挡) return { ok: false, error: 挡 };
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

/** 自动推进了才带上 自动推到（没推的返回和原来一模一样） */
const 带推进 = (到: string[]) => (到.length ? { 自动推到: 到 } : {});

/**
 * 改节点：往前只能一步一步走，往后随便退（nodes.ts 改节点问题），点结局也走这里。每改一次记一行 ProjectNodeLog。
 * 有结局记下 closedAt，回到进行中（= 从异常状态恢复、从丢单捡回来）清掉。
 * 进异常状态要选一个在用的异常类别，备注可空；类别和备注只在异常状态时留在项目上，节点变更里永远留着。
 * 企业版点线索流失、丢单要写原因（第四个参数的 备注），只记在节点变更里
 */
export async function 改节点(
  me: 谁, projectId: string, 到: 位置, 异常?: { categoryId?: string | null; 备注?: string | null },
): Promise<结果 & { 变了?: boolean; 自动推到?: string[] }> {
  const 规则 = await 生效组织规则();
  const org = 企业版() ? await 读组织() : null;
  const 推的组织 = await 直属才推(org);
  return 查完再写(async (tx) => {
    const p = await tx.project.findUnique({ where: { id: String(projectId ?? "") } });
    if (!p) return { ok: false as const, error: "这个项目已经不在了，刷新看看" };
    if (!能改节点(me, p, org)) return { ok: false as const, error: p.pooledAt ? "这个项目在公海里，先领取再改" : "只有项目负责人、老板或主管能改节点" };
    const result = 到.result || null;
    const 问题 = 改节点问题({ ...到, result }, p, 异常, 企业版());
    if (问题) return { ok: false as const, error: 问题 };
    const 往前 = !result && !p.result && 节点序号(到) > 节点序号(p);
    const 不给 = 往前 ? 往前推不给(me, p.ownerId, 推的组织) : null;
    if (不给) return { ok: false as const, error: 不给 };
    // 企业版节点必填（D-37）：配了必填的节点，往前推只给老板、主管、负责人的直属上级、总管理员；销售本人填齐了自动推
    if (往前 && 按必填走(规则, p.node) && me.role !== "ADMIN" && me.role !== "MANAGER" && !代管节点(me, p.ownerId, org)) {
      const 差 = 还差(规则, await 读必填数据(tx, p));
      return {
        ok: false as const,
        error: 差.length
          ? `「${p.node}」填齐必填后自动往前推，还差：${差.map(必填叫法).join("、")}；要先推请找老板或主管`
          : `「${p.node}」的必填已经齐了，保存一下就会自动往前推`,
      };
    }
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
    // 线索流失、丢单的原因只记在节点变更里，项目上的 exceptionReason 是异常状态专用
    const 原因 = 企业版() && 要写原因(result) ? (异常?.备注 ?? "").trim().slice(0, 原因上限) || null : 备注;
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
        toPhase: 到.phase, toNode: 到.node, toResult: result, categoryId: 类别, reason: 原因,
      },
    });
    // 老板、主管往前推到的节点也配了、也齐了：接着推
    return { ok: true as const, 变了: true, ...带推进(往前 ? await 按必填推进(tx, 规则, me, p.id, true) : []) };
  });
}

export const 交付项们 = { balanceSettled: "尾款结清", acceptancePassed: "验收通过" } as const;
export type 交付项 = keyof typeof 交付项们;

/** 勾 / 取消尾款结清、验收通过，记谁、何时。已经成功交付的不让取消（先把节点改回去） */
export async function 勾交付(me: 谁, projectId: string, 项: 交付项, 勾: boolean): Promise<结果 & { 变了?: boolean; 自动推到?: string[] }> {
  if (!(项 in 交付项们)) return { ok: false, error: "没有这一项" };
  const 规则 = await 生效组织规则();
  return 查完再写(async (tx) => {
    const p = await tx.project.findUnique({ where: { id: String(projectId ?? "") } });
    if (!p) return { ok: false as const, error: "这个项目已经不在了，刷新看看" };
    if (!能管项目(me, p)) return { ok: false as const, error: "只有项目负责人、老板或主管能勾" };
    if (p[项] === 勾) return { ok: true as const, 变了: false };
    if (!勾 && p.result === "成功交付") return { ok: false as const, error: `已经成功交付了；要取消「${交付项们[项]}」，先把节点改回去` };
    const 谁勾 = 项 === "balanceSettled" ? { balanceSettledById: 勾 ? me.id : null, balanceSettledAt: 勾 ? new Date() : null } : { acceptancePassedById: 勾 ? me.id : null, acceptancePassedAt: 勾 ? new Date() : null };
    await tx.project.update({ where: { id: p.id }, data: { [项]: 勾, ...谁勾 } });
    return { ok: true as const, 变了: true, ...带推进(await 按必填推进(tx, 规则, me, p.id)) };
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
  reason: string | null = null,
) {
  await tx.projectNodeLog.create({ data: 转让痕(p, 操作人, 从, 到, kind, reason) });
}

/** 记转让 写的那一行；一次转很多个（停用成员）时拼好用 createMany 一起写 */
export function 转让痕(
  p: { id: string; phase: string; node: string; result: string | null },
  操作人: string, 从: string | null, 到: string | null,
  kind: "transfer" | "pool-release" | "pool-claim" = "transfer",
  reason: string | null = null,
) {
  return {
    projectId: p.id, userId: 操作人, kind, fromOwnerId: 从, toOwnerId: 到, reason,
    fromPhase: p.phase, fromNode: p.node, fromResult: p.result,
    toPhase: p.phase, toNode: p.node, toResult: p.result,
  };
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
export async function 改项目(me: 谁, projectId: string, patch: 向导项目 & { contactId?: string | null }): Promise<结果 & { 变了?: string[]; 自动推到?: string[] }> {
  if (!patch || typeof patch !== "object") return { ok: false, error: "要改什么？" };
  const 规则 = await 生效组织规则();
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
    if (换人) {
      // 这里改不了阶段和结局（规整项目只出名称、负责人、金额、备注），p 的阶段 / 结局就是改完的
      const 超 = await 超上限(tx, 规则, 新.ownerId, p);
      if (超) return { ok: false as const, error: 超 };
    }
    // 换了人，上一位填的下一步时间不替新负责人算（超时回收从接手那天重新算）
    await tx.project.update({ where: { id: p.id }, data: { ...新, ...(换人 ? { nextStepAt: null } : {}), ...(换人 && p.pooledAt ? { pooledAt: null } : {}) } });
    if (换人) await 记转让(tx, p, me.id, p.ownerId, 新.ownerId);
    return { ok: true as const, 变了, ...带推进(await 按必填推进(tx, 规则, me, p.id)) };
  });
}

/** 能进公海的阶段：线索、商机；订单阶段不能放 */
export const 能进公海的阶段 = ["线索", "商机"] as const;

/**
 * 手上的项目数（企业版持有上限按这个算）：线索 / 商机阶段、还在走（没结局）、不在公海。
 * 不管怎么到手的——自己建的、领的、被指派的、自动分配的——都算
 */
export async function 持有数(db: Pick<Prisma.TransactionClient, "project">, userId: string): Promise<number> {
  return db.project.count({ where: { ownerId: userId, pooledAt: null, result: null, phase: { in: [...能进公海的阶段] } } });
}

/**
 * 再把这个项目给 userId 会不会超持有上限：超了返回一句报错，没超 / 不是企业版 / 没开上限 / 这个项目不算持有（订单阶段、有结局）返回 null。
 * 拦领取、拦指派（改负责人、建档时负责人选别人）、自动分配也调这个；自己建档、跟着客户转、离职交接不拦。
 * 规则在进事务前读好传进来：事务占着库的唯一连接，事务里再走 getSetting 会等到超时
 */
export async function 超上限(
  db: Pick<Prisma.TransactionClient, "project" | "user">,
  规则: 组织规则,
  userId: string,
  p: { phase: string; result: string | null },
): Promise<string | null> {
  if (!企业版()) return null;
  if (p.result || !(能进公海的阶段 as readonly string[]).includes(p.phase)) return null;
  const 上限 = 持有上限of(规则, userId);
  if (上限 === null) return null;
  const 有 = await 持有数(db, userId);
  if (有 < 上限) return null;
  const 谁 = (await db.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? "这位成员";
  return `${谁}手上已经有 ${有} 个线索 / 商机阶段的项目，到持有上限（${上限} 个）了，先推进或放回一些再接`;
}

/**
 * 放回公海：只有负责人本人能放，线索 / 商机阶段才行。ownerId 留着放回去的人（他就是「历史负责人」；企业版里自己也能再领回，别的版本不能），
 * 记一行 pool-release。项目组、节点、交付两项都不动
 */
export async function 放回公海(me: 谁, projectId: string): Promise<结果> {
  return 查完再写(async (tx) => {
    const p = await tx.project.findUnique({ where: { id: String(projectId ?? "") } });
    if (!p) return { ok: false as const, error: "这个项目已经不在了，刷新看看" };
    if (p.pooledAt) return { ok: false as const, error: "这个项目已经在公海里了" };
    if (me.id !== p.ownerId) return { ok: false as const, error: "只有项目负责人能放回公海" };
    if (!(能进公海的阶段 as readonly string[]).includes(p.phase)) return { ok: false as const, error: "订单阶段的项目不能放回公海" };
    await tx.project.update({ where: { id: p.id }, data: { pooledAt: new Date(), nextStepAt: null } });
    await 记转让(tx, p, me.id, p.ownerId, null, "pool-release");
    return { ok: true as const };
  });
}

const 领走了 = { ok: false as const, error: "这个项目已经被人领走了，刷新看看" };

/**
 * 从公海领取：谁都能领；放回去的那位企业版里能领回（10-24 定），别的版本照旧不能自己领回。领了就是新负责人，记一行 pool-claim。
 * 开了持有上限的，到上限了领不了
 */
export async function 领取公海项目(me: 谁, projectId: string): Promise<结果> {
  const 规则 = await 生效组织规则();
  return 查完再写(async (tx) => {
    const id = String(projectId ?? "");
    const p = await tx.project.findUnique({ where: { id } });
    // 两人同时领：先进来的领走了，项目就落到后进来那位的范围外（业务员只看自己的 + 公海），带限定查是空的；
    // 不带限定再看一眼，还在就是被人领走了，不是删了（D-35）
    if (!p) return (await 看全部(() => tx.project.findUnique({ where: { id }, select: { id: true } })))
      ? 领走了 : { ok: false as const, error: "这个项目已经不在了，刷新看看" };
    if (!p.pooledAt) return 领走了;
    if (!(await 在职(tx, me.id))) return { ok: false as const, error: "账号已停用" };
    if (!企业版() && me.id === p.ownerId) return { ok: false as const, error: "自己放回公海的项目不能自己领回" };
    const 超 = await 超上限(tx, 规则, me.id, p);
    if (超) return { ok: false as const, error: 超 };
    await tx.project.update({ where: { id: p.id }, data: { ownerId: me.id, pooledAt: null } });
    await 记转让(tx, p, me.id, p.ownerId, me.id, "pool-claim");
    return { ok: true as const };
  });
}

/** 本机记的「今天按这份规则扫过了」：值 = 日期 + 规则，老板改了时长当天再扫一遍 */
const 超时扫过键 = "projectTimeoutSweptOn";

const 算超时要的 = {
  id: true, name: true, phase: true, node: true, result: true, pooledAt: true, nextStepAt: true, ownerId: true, customerId: true, createdAt: true,
  customer: { select: { lastFollowAt: true, pool: { select: { customerId: true } } } },
  logs: { select: { at: true }, orderBy: { at: "desc" as const }, take: 1 },
} satisfies Prisma.ProjectSelect;
type 待查项目 = Prisma.ProjectGetPayload<{ select: typeof 算超时要的 }>;

/**
 * 起点 = 最近一次有人管：建项目、最后一行节点变更 / 转让 / 领取、客户上最后一次跟进，取最晚的（timeout.ts）。
 * 客户在客户公海里的不收（企业版第四节）：项目跟着客户，谁领客户谁带走；先收进项目公海就和客户拆开了
 */
function 超时了(规则: 组织规则, p: 待查项目, 今: Date): boolean {
  if (p.customer.pool) return false;
  return 已超时(超时回收日(规则, p, 超时起点(p.createdAt, p.logs[0]?.at, p.customer.lastFollowAt)), 今);
}

/** 按这份规则现在超时的项目（还在线索 / 商机、没结局、不在公海、节点设了时长） */
async function 超时的项目(规则: 组织规则, 今: Date, ownerId?: string): Promise<待查项目[]> {
  const 节点 = Object.keys(规则.超时回收.节点天数);
  if (!规则.超时回收.开 || !节点.length) return [];
  const 们 = await prisma.project.findMany({
    where: { pooledAt: null, result: null, phase: { in: [...能进公海的阶段] }, node: { in: 节点 }, customer: { pool: { is: null } }, ...(ownerId ? { ownerId } : {}) },
    select: 算超时要的,
  });
  return 们.filter((p) => 超时了(规则, p, 今));
}

/** 老板改时长前先看：按这份规则现在会有几个项目回到公海（不分谁的，全看） */
export async function 超时预览(规则: 组织规则, 今: Date = new Date()): Promise<number> {
  return 看全部(async () => (await 超时的项目(规则, 今)).length);
}

/**
 * 超时回收（企业版，D-34）：线索 / 商机阶段的项目在节点上超过处理时长没人管，自动回到项目公海，
 * 负责人收到一条待办提醒；留痕和放回公海一样（pool-release），理由写明是超时。没开 / 没设时长什么都不做。
 * 项目列表、首页加载时调，一天按同一份规则最多扫一次；老板刚改了时长也直接调一次。
 * 团队模式下每台只扫自己名下的（和客户公海 自动掉公海 一个道理：别人的跟进本机可能还没拉到）。
 * 「今天扫过了」的记号只管扫过的那一片（Y18）：只扫了某人名下的，记在这个人的号上，不挡全公司扫、也不挡别人。
 * 扫、收都包在 看全部() 里：企业版网页上是谁打开页面就带着谁的范围（按组织看客户），低权限的人先触发时
 * 只查得到自己 + 下属的项目，却记成全公司扫过（质量 3700 复测）。扫多大一片只看上面的 只扫
 */
export async function 公海超时收回(me: { id: string; name: string }, 今: Date = new Date()): Promise<number> {
  return 看全部(() => 按规则收回(me, 今));
}

async function 按规则收回(me: { id: string; name: string }, 今: Date): Promise<number> {
  const 规则 = await 生效组织规则();
  if (!规则.超时回收.开) return 0;
  const 只扫 = 读团队() ? me.id : undefined;
  const 键 = 只扫 ? `${超时扫过键}:${只扫}` : 超时扫过键;
  const 记号 = `${dayjs(今).format("YYYY-MM-DD")} ${JSON.stringify(规则.超时回收)}`;
  if ((await getSetting<string>(键)) === 记号) return 0;

  const 们 = await 超时的项目(规则, 今, 只扫);
  const 收了: string[] = [];
  for (const p of 们) {
    // 逐个一笔事务：查出来到写下去之间有人刚推了节点、领了、记了沟通，就不收
    const 收 = await 查完再写(async (tx) => {
      const 现 = await tx.project.findUnique({ where: { id: p.id }, select: 算超时要的 });
      if (!现 || 现.ownerId !== p.ownerId || !超时了(规则, 现, 今)) return false;
      await tx.project.update({ where: { id: p.id }, data: { pooledAt: 今, nextStepAt: null } });
      await 记转让(tx, p, me.id, p.ownerId, null, "pool-release", 超时理由);
      await tx.task.create({
        data: {
          title: `项目「${p.name}」在「${p.node}」超过处理时长没跟进，已回到项目公海`,
          dueAt: 今, dueOn: dayjs(今).format("YYYY-MM-DD"), dueHasTime: false,
          customerId: p.customerId, ownerId: p.ownerId,
        },
      });
      return true;
    });
    if (收) 收了.push(p.id);
  }
  if (收了.length) {
    await recordAudit({
      user: me, action: "pool", entity: "Project",
      summary: `${收了.length} 个项目超过节点处理时长没跟进，自动回到项目公海`,
      detail: { ids: 收了, 节点天数: 规则.超时回收.节点天数 },
    });
  }
  await setSetting(键, 记号);
  return 收了.length;
}

/**
 * 在项目上记一条沟通：负责人、老板、主管、项目组成员能记；在公海里的先领取。
 * 开了超时回收、项目在线索 / 商机阶段（还没结局）时必须填下一步时间。
 * 跟进挂在客户上（客户页也看得到）+ 挂上项目当时的节点；客户的最近跟进往后推；填了下一步时间写到项目上
 */
export async function 记项目沟通(me: 谁, projectId: string, input: 向导跟进, now: Date = new Date()): Promise<结果 & { followUpId?: string; 自动推到?: string[] }> {
  if (!input || typeof input !== "object") return { ok: false, error: "要记什么？" };
  const 规则 = await 生效组织规则();
  return 查完再写(async (tx) => {
    const p = await tx.project.findUnique({ where: { id: String(projectId ?? "") } });
    if (!p) return { ok: false as const, error: "这个项目已经不在了，刷新看看" };
    if (p.pooledAt) return { ok: false as const, error: "这个项目在公海里，先领取再记" };
    if (!能管项目(me, p)) {
      const 组员 = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId: p.id, userId: me.id } }, select: { inviteStatus: true } });
      if (组员?.inviteStatus !== "JOINED") return { ok: false as const, error: "只有项目负责人、项目组成员、老板或主管能记沟通" };
    }
    const 要下一步 = 规则.超时回收.开 && !p.result && (能进公海的阶段 as readonly string[]).includes(p.phase);
    const 好 = 规整沟通(input, { 要下一步, now });
    if ("error" in 好) return { ok: false as const, error: 好.error };
    const 跟进 = await tx.followUp.create({
      data: { type: 好.type, content: 好.content, occurredAt: 好.occurredAt, title: "", status: "已完成", customerId: p.customerId, contactId: p.contactId, ownerId: me.id },
    });
    await tx.followUpProject.create({ data: { followUpId: 跟进.id, projectId: p.id, node: p.node } });
    // 企业版组员不一定看得到这位客户（客户是负责人的）：最近跟进时间只是跟着记一笔，不按范围拦
    const c = await 看全部(() => tx.customer.findUnique({ where: { id: p.customerId }, select: { lastFollowAt: true } }));
    if (!c?.lastFollowAt || c.lastFollowAt < 好.occurredAt) await 看全部(() => tx.customer.update({ where: { id: p.customerId }, data: { lastFollowAt: 好.occurredAt } }));
    if (好.nextStepAt) await tx.project.update({ where: { id: p.id }, data: { nextStepAt: 好.nextStepAt } });
    return { ok: true as const, followUpId: 跟进.id, ...带推进(await 按必填推进(tx, 规则, me, p.id)) };
  });
}

/**
 * 加组员：能管项目的人拉，1a 直接进组（inviteStatus = JOINED）。
 * 企业版（10-26）= 发邀请（INVITED），对方在自己那边点同意才进组，同意前不算组员、看不到项目；
 * 拒绝过的（DECLINED）可以再邀一次；拉自己直接进组。组长 = 项目负责人。
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
    const 发邀请 = 企业版() && uid !== me.id;
    const 有 = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId: p.id, userId: uid } } });
    if (有 && 发邀请 && 有.inviteStatus === "DECLINED") {
      await tx.projectMember.update({ where: { id: 有.id }, data: { roleId: 角色, inviteStatus: "INVITED", invitedById: me.id } });
      return { ok: true as const };
    }
    if (有) return { ok: false as const, error: 有.inviteStatus === "INVITED" ? "已经邀请过这位了，等对方同意" : "这位已经在项目组里了" };
    await tx.projectMember.create({ data: { projectId: p.id, userId: uid, roleId: 角色, inviteStatus: 发邀请 ? "INVITED" : "JOINED", invitedById: me.id } });
    return { ok: true as const };
  });
}

/** 企业版：被邀请的人回邀请。只有本人能回、只回还在等的；同意 = 进组（JOINED），拒绝 = DECLINED（负责人那边看得到「没接受」，能再邀） */
export async function 回邀请(me: 谁, memberId: string, 同意: boolean): Promise<结果 & { projectId?: string }> {
  return 查完再写(async (tx) => {
    // 同意前看不到项目（团队范围里只算 JOINED 的组员），这一行按 id 取、只认本人
    const m = await 看全部(() => tx.projectMember.findUnique({ where: { id: String(memberId ?? "") }, select: { id: true, userId: true, projectId: true, inviteStatus: true } }));
    if (!m || m.userId !== me.id) return { ok: false as const, error: "这个邀请已经不在了，刷新看看" };
    if (m.inviteStatus !== "INVITED") return { ok: false as const, error: m.inviteStatus === "JOINED" ? "你已经在项目组里了" : "你已经拒绝过这个邀请了" };
    await 看全部(() => tx.projectMember.update({ where: { id: m.id }, data: { inviteStatus: 同意 ? "JOINED" : "DECLINED" } }));
    return { ok: true as const, projectId: m.projectId };
  });
}

export type 待回邀请 = { id: string; projectId: string; 项目: string; 负责人: string; 邀请人: string; 角色: string | null; createdAt: Date };

/** 企业版：等我回的项目组邀请（只带项目名、负责人、谁邀的、角色，项目里的东西同意了才看得到） */
export async function 待我回的邀请(me: 谁): Promise<待回邀请[]> {
  if (!企业版()) return [];
  const rows = await 看全部(() => prisma.projectMember.findMany({
    where: { userId: me.id, inviteStatus: "INVITED" },
    select: { id: true, projectId: true, invitedById: true, createdAt: true, role: { select: { name: true } }, project: { select: { name: true, ownerId: true } } },
    orderBy: { createdAt: "desc" },
  }));
  const ids = [...new Set(rows.flatMap((r) => [r.project.ownerId, r.invitedById].filter((x): x is string => !!x)))];
  const 名 = new Map((await 看全部(() => prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }))).map((u) => [u.id, u.name || u.email]));
  return rows.map((r) => ({
    id: r.id, projectId: r.projectId, 项目: r.project.name, 负责人: 名.get(r.project.ownerId) ?? "—",
    邀请人: (r.invitedById && 名.get(r.invitedById)) || "—", 角色: r.role?.name ?? null, createdAt: r.createdAt,
  }));
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

/**
 * 算「还差」要的数据（企业版节点必填，D-37）：客户（含外贸字段）、客户下的联系人、项目上的沟通各在哪个节点记的。
 * 只用 tx：保存的那笔事务里调，刚写的也读得到
 */
export async function 读必填数据(
  tx: Prisma.TransactionClient,
  p: { id: string; customerId: string; node: string; contactId: string | null; nextStepAt: Date | null; amount: number; remark: string | null; acceptancePassed: boolean },
): Promise<必填数据> {
  const [c, 联系人们, 沟通] = await Promise.all([
    tx.customer.findUnique({
      where: { id: p.customerId },
      select: { phone: true, expectedSignAt: true, extra: { select: { country: true, whatsapp: true, wechat: true, email: true, source: true, level: true, alibabaId: true } } },
    }),
    tx.contact.findMany({ where: { customerId: p.customerId }, select: { phone: true, email: true, wechat: true } }),
    tx.followUpProject.findMany({ where: { projectId: p.id }, select: { node: true }, distinct: ["node"] }),
  ]);
  return {
    项目: { node: p.node, contactId: p.contactId, nextStepAt: p.nextStepAt, amount: p.amount, remark: p.remark, acceptancePassed: p.acceptancePassed },
    客户: { phone: c?.phone ?? null, expectedSignAt: c?.expectedSignAt ?? null, extra: c?.extra ?? null },
    联系人们,
    沟通节点们: 沟通.map((x) => x.node),
  };
}

export const 自动推进理由 = "必填齐了，自动推进";

/**
 * 是不是往前走进现在这个节点的：最后一行进这个节点的节点变更是往前（或建项目那一行）。
 * 退回来的不自动推（退回一般是要重做，等上级手动推）
 */
async function 往前进来的(tx: Prisma.TransactionClient, p: { id: string; phase: string; node: string }): Promise<boolean> {
  const 们 = await tx.projectNodeLog.findMany({
    where: { projectId: p.id, kind: "node", toPhase: p.phase, toNode: p.node, toResult: null },
    orderBy: [{ at: "desc" }, { id: "desc" }], take: 1,
    select: { fromPhase: true, fromNode: true },
  });
  const 上次 = 们[0];
  if (!上次?.fromPhase || !上次.fromNode) return true;
  return 节点序号(p) > 节点序号({ phase: 上次.fromPhase, node: 上次.fromNode });
}

/**
 * 企业版节点必填（D-37）：现在的节点配了必填、全齐了、是往前走进来的，就往前推一步，记一行节点变更（理由写明自动推进，操作人 = 这次保存的人）；
 * 推到的节点也配了、也齐了，接着推。返回推到的节点（没推 = 空）。
 * 没生效时一行都不查。在保存的那笔事务里调，规则在事务外读好传进来。
 * 刚往前推进来（老板、主管手动推）的传 刚往前 = true，省一次查
 */
export async function 按必填推进(tx: Prisma.TransactionClient, 规则: 组织规则, me: { id: string }, projectId: string, 刚往前 = false): Promise<string[]> {
  if (!节点推进生效(规则)) return [];
  const 到了: string[] = [];
  let 往前 = 刚往前;
  for (;;) {
    const p = await tx.project.findUnique({ where: { id: projectId } });
    if (!p || p.pooledAt || p.result || !按必填走(规则, p.node)) break;
    const 下 = 下一步(p);
    if (!下) break;
    if (!往前 && !(await 往前进来的(tx, p))) break;
    if (还差(规则, await 读必填数据(tx, p)).length) break;
    await tx.project.update({ where: { id: p.id }, data: { phase: 下.phase, node: 下.node } });
    await tx.projectNodeLog.create({
      data: {
        projectId: p.id, userId: me.id, reason: 自动推进理由,
        fromPhase: p.phase, fromNode: p.node, fromResult: null, toPhase: 下.phase, toNode: 下.node, toResult: null,
      },
    });
    到了.push(下.node);
    往前 = true;
  }
  return 到了;
}

/**
 * 客户这边存了东西（客户资料、联系人、客户上的跟进）：这位客户名下停在配了必填节点上的项目，齐了的往前推。
 * 每个项目一笔事务；没生效时不查库。返回推了的项目和推到的节点（操作日志用）
 */
export async function 客户项目按必填推进(me: { id: string }, customerId: string): Promise<{ id: string; name: string; 到: string[] }[]> {
  const 规则 = await 生效组织规则();
  if (!节点推进生效(规则) || !customerId) return [];
  const 配了的 = Object.keys(规则.节点推进.必填).filter((n) => 节点必填(规则, n).length);
  const 们 = await prisma.project.findMany({ where: { customerId, pooledAt: null, result: null, node: { in: 配了的 } }, select: { id: true, name: true } });
  const 推了: { id: string; name: string; 到: string[] }[] = [];
  for (const p of 们) {
    const 到 = await 查完再写((tx) => 按必填推进(tx, 规则, me, p.id));
    if (到.length) 推了.push({ ...p, 到 });
  }
  return 推了;
}
