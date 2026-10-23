/**
 * 团队版项目模式 1b（2026-10-23）：部门树、成员的部门和业务角色、「角色 × 范围」配置表、项目进组邀请——中继这一半。
 * 判定规则都在 lib/sync/dept-policy.ts（纯函数），这里只读写控制库、给 sync-scoped 的 auth 算读写档。
 *
 * 没有部门、没有角色行、没有配置行 = 老团队原样：老板看全部、主管看全队、业务员看自己 + 互看开关（tests/sync-scoped-dept.test.ts 等价测试）。
 * 谁能改：建团队的人，加上业务角色是总管理、管理员的人（10-23 拍板：管理员能管部门和成员）。
 */
import { randomUUID } from "node:crypto";
import { control } from "./control";
import type { Prisma } from "@/generated/control";
import { 团队索引 } from "./scoped-index";
import {
  业务角色 as 角色表, 默认范围, 虚线下属, 虚线上级规则, 能管人, 是业务角色, 是数据范围, 推业务角色, 老角色, 一级部门表, 默认一级部门, 部门判定, 读写档, 部门最多层数,
  type 业务角色, type 数据范围, type 部门行,
} from "../sync/dept-policy";
import type { 读限 } from "../sync/scope-policy";

type Db = typeof control | Prisma.TransactionClient;
type 结果<T> = ({ ok: true } & T) | { ok: false; 状态: number; error: string };
const 错 = (状态: number, error: string) => ({ ok: false as const, 状态, error });
const 名字对 = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0 && s.trim().length <= 40;

/** 一个团队的部门、角色、配置表（每次请求现读：几张小表，改了马上生效） */
export async function 团队编制(teamId: string, db: Db = control) {
  const [depts, roles, scopes] = await Promise.all([
    db.syncDept.findMany({ where: { teamId }, orderBy: [{ sort: "asc" }, { createdAt: "asc" }] }),
    db.syncMemberRole.findMany({ where: { teamId } }),
    db.syncRoleScope.findMany({ where: { teamId } }),
  ]);
  const 范围表 = { ...默认范围 } as Record<业务角色, 数据范围>;
  for (const s of scopes) if (是业务角色(s.bizRole) && 是数据范围(s.scope)) 范围表[s.bizRole] = s.scope;
  return { depts, roles: new Map(roles.map((r) => [r.accountId, r])), 范围表 };
}

/** 这个人的业务角色：有角色行用它，没有按老角色推 */
export function 角色of(编制: Awaited<ReturnType<typeof 团队编制>>, accountId: string, 建的人: boolean, 老: string | null | undefined): 业务角色 {
  if (建的人) return "director";
  const r = 编制.roles.get(accountId)?.bizRole;
  return 是业务角色(r) ? r : 推业务角色(false, 老);
}

/**
 * sync-scoped auth 用：owner / manager / share 三样（意思不变）+ 限（部门判定、已进的项目组）。
 * 团队少于两个一级部门、范围是全公司时没有部门判定：和 1b 之前算出来一模一样
 */
export async function 读写身份(o: { teamId: string; accountId: string; 建的人: boolean; 老角色: string | null; 互看开关: boolean }, db: Db = control): Promise<{ owner: boolean; manager: boolean; share: boolean; 限: 读限; 角色: 业务角色; 范围: 数据范围 }> {
  const 编制 = await 团队编制(o.teamId, db);
  const 角色 = 角色of(编制, o.accountId, o.建的人, o.老角色);
  const 范围 = 编制.范围表[角色];
  const members = await db.syncMember.findMany({ where: { teamId: o.teamId, leftAt: null }, select: { accountId: true } });
  const 部门 = 部门判定({ 我: o.accountId, 我的范围: 范围, depts: 编制.depts, members: members.map((m) => ({ accountId: m.accountId, deptId: 编制.roles.get(m.accountId)?.deptId ?? null })) });
  const 档 = 读写档({ 建的人: o.建的人, 范围, 互看开关: o.互看开关, 部门 });
  const 进组 = new Set((await db.syncProjectInvite.findMany({ where: { teamId: o.teamId, accountId: o.accountId, status: "accepted" }, select: { scopeId: true } })).map((x) => x.scopeId));
  const 虚线 = 虚线下属(new Map([...编制.roles].map(([a, r]) => [a, r.dottedManagerId])), o.accountId, new Set(members.map((m) => m.accountId)));
  const 限: 读限 = { ...(档.部门 ? { 部门: 档.部门 } : {}), ...(进组.size ? { 进组 } : {}), ...(虚线.size ? { 虚线, 虚线加跟进: 虚线上级规则.可改 === "加跟进" } : {}) };
  return { owner: 档.owner, manager: 档.manager, share: 档.share, 限, 角色, 范围 };
}

/** 能改部门、成员角色、配置表的人：建团队的人 + 总管理、管理员 */
async function 能管(teamId: string, accountId: string) {
  const t = await control.syncTeam.findUnique({ where: { id: String(teamId ?? "") } });
  if (!t) return null;
  if (t.ownerAccountId === accountId) return t;
  const m = await control.syncMember.findUnique({ where: { teamId_accountId: { teamId: t.id, accountId } } });
  if (!m || m.leftAt) return null;
  const r = await control.syncMemberRole.findUnique({ where: { teamId_accountId: { teamId: t.id, accountId } } });
  const 角色 = 是业务角色(r?.bizRole) ? r.bizRole : 推业务角色(false, m.role);
  return 能管人.has(角色) ? t : null;
}
const 管不了 = "只有老板、总管理、管理员能改部门和成员";

/** 部门第几层（一级 = 1）；断链、成环回 Infinity */
function 层数(depts: readonly 部门行[], id: string | null): number {
  const by = new Map(depts.map((d) => [d.id, d]));
  let n = 0;
  for (let cur = id ? by.get(id) : undefined; cur; cur = cur.parentId ? by.get(cur.parentId) : undefined) {
    if (++n > 部门最多层数 + 1) return Infinity;
    if (cur.parentId && !by.has(cur.parentId)) return Infinity;
  }
  return n;
}
/** 子树最深多少层（自己算 1） */
function 子树深(depts: readonly 部门行[], id: string): number {
  const kids = depts.filter((d) => d.parentId === id);
  return 1 + Math.max(0, ...kids.map((k) => 子树深(depts, k.id)));
}

export async function 建部门(accountId: string, teamId: string, name: unknown, parentId: unknown): Promise<结果<{ id: string }>> {
  const t = await 能管(teamId, accountId);
  if (!t) return 错(403, 管不了);
  if (!名字对(name)) return 错(400, "部门名 1–40 个字");
  const depts = await control.syncDept.findMany({ where: { teamId: t.id } });
  const parent = parentId == null || parentId === "" ? null : String(parentId);
  if (parent && !depts.some((d) => d.id === parent)) return 错(404, "上级部门不存在");
  if (层数(depts, parent) + 1 > 部门最多层数) return 错(400, `部门最多 ${部门最多层数} 层`);
  if (depts.some((d) => d.parentId === parent && d.name === name.trim())) return 错(409, "同一级已经有这个部门了");
  const id = randomUUID().replace(/-/g, "").slice(0, 20);
  await control.syncDept.create({ data: { id, teamId: t.id, name: name.trim(), parentId: parent, sort: depts.filter((d) => d.parentId === parent).length } });
  return { ok: true, id };
}

/** 改名、挪到别的上级下（挪完整棵子树仍不超过三层、不成环） */
export async function 改部门(accountId: string, teamId: string, id: unknown, 改: { name?: unknown; parentId?: unknown; sort?: unknown }): Promise<结果<object>> {
  const t = await 能管(teamId, accountId);
  if (!t) return 错(403, 管不了);
  const depts = await control.syncDept.findMany({ where: { teamId: t.id } });
  const d = depts.find((x) => x.id === id);
  if (!d) return 错(404, "部门不存在");
  const data: Prisma.SyncDeptUpdateInput = {};
  if (改.name !== undefined) {
    if (!名字对(改.name)) return 错(400, "部门名 1–40 个字");
    data.name = 改.name.trim();
  }
  if (改.parentId !== undefined) {
    const parent = 改.parentId == null || 改.parentId === "" ? null : String(改.parentId);
    if (parent && !depts.some((x) => x.id === parent)) return 错(404, "上级部门不存在");
    for (let cur = parent; cur; cur = depts.find((x) => x.id === cur)?.parentId ?? null) if (cur === d.id) return 错(400, "不能挪到自己下面");
    if (层数(depts, parent) + 子树深(depts, d.id) > 部门最多层数) return 错(400, `部门最多 ${部门最多层数} 层`);
    data.parentId = parent;
  }
  if (改.sort !== undefined) {
    if (!Number.isSafeInteger(改.sort)) return 错(400, "排序不对");
    data.sort = 改.sort as number;
  }
  await control.syncDept.update({ where: { id: d.id }, data });
  return { ok: true };
}

/** 删部门：底下没有子部门、没有人才能删（人先调走，数据跟人走） */
export async function 删部门(accountId: string, teamId: string, id: unknown): Promise<结果<object>> {
  const t = await 能管(teamId, accountId);
  if (!t) return 错(403, 管不了);
  const d = await control.syncDept.findFirst({ where: { teamId: t.id, id: String(id ?? "") } });
  if (!d) return 错(404, "部门不存在");
  if (await control.syncDept.count({ where: { teamId: t.id, parentId: d.id } })) return 错(409, "先删掉或挪走下面的子部门");
  const 在册 = (await control.syncMember.findMany({ where: { teamId: t.id, leftAt: null }, select: { accountId: true } })).map((m) => m.accountId);
  if (await control.syncMemberRole.count({ where: { teamId: t.id, deptId: d.id, accountId: { in: 在册 } } })) return 错(409, "部门里还有人：先把人调到别的部门");
  await control.syncMemberRole.updateMany({ where: { teamId: t.id, deptId: d.id }, data: { deptId: null } });
  await control.syncDept.delete({ where: { id: d.id } });
  return { ok: true };
}

/**
 * 调人：部门、业务角色、虚线上级（虚线链上的人名下的客户只读可看，见 读写身份）。业务角色同步写回老角色（SyncMember.role），老客户端按名单对本机角色照旧能用。
 * 调部门不另做客户迁移、不提示交接（10-23 定：不在 1b 里做）；隔离本来就按负责人现在的部门算
 */
export async function 设成员(accountId: string, teamId: string, 谁: unknown, 改: { bizRole?: unknown; deptId?: unknown; dottedManagerId?: unknown }): Promise<结果<{ bizRole: 业务角色; deptId: string | null }>> {
  const t = await 能管(teamId, accountId);
  if (!t) return 错(403, 管不了);
  const m = await control.syncMember.findUnique({ where: { teamId_accountId: { teamId: t.id, accountId: String(谁 ?? "") } } });
  if (!m || m.leftAt) return 错(404, "这个人已经不在团队里了");
  const 是老板 = m.accountId === t.ownerAccountId;
  const 旧 = await control.syncMemberRole.findUnique({ where: { teamId_accountId: { teamId: t.id, accountId: m.accountId } } });
  let bizRole: 业务角色 = 是业务角色(旧?.bizRole) ? 旧.bizRole : 推业务角色(是老板, m.role);
  // 总管理（含老板）的部门、虚线也只有老板能动：管理员动不了总管理
  if (accountId !== t.ownerAccountId && (是老板 || bizRole === "director")) return 错(403, "只有老板能改总管理");
  let deptId = 旧?.deptId ?? null;
  let dotted = 旧?.dottedManagerId ?? null;
  if (改.bizRole !== undefined) {
    if (!是业务角色(改.bizRole)) return 错(400, "没有这个角色");
    if (是老板 && 改.bizRole !== "director") return 错(400, "老板（建团队的人）固定是总管理");
    // 管理员不能把人升成总管理、也不能动总管理：免得管理员把老板请的总管理降掉
    if (accountId !== t.ownerAccountId && (改.bizRole === "director" || bizRole === "director") && 改.bizRole !== bizRole) return 错(403, "只有老板能设、撤总管理");
    bizRole = 改.bizRole;
  }
  if (改.deptId !== undefined) {
    deptId = 改.deptId == null || 改.deptId === "" ? null : String(改.deptId);
    if (deptId && !(await control.syncDept.findFirst({ where: { teamId: t.id, id: deptId } }))) return 错(404, "部门不存在");
  }
  if (改.dottedManagerId !== undefined) {
    dotted = 改.dottedManagerId == null || 改.dottedManagerId === "" ? null : String(改.dottedManagerId);
    if (dotted === m.accountId) return 错(400, "虚线上级不能是自己");
    if (dotted && !(await control.syncMember.findFirst({ where: { teamId: t.id, accountId: dotted, leftAt: null } }))) return 错(404, "虚线上级不在团队里");
  }
  await control.$transaction(async (tx) => {
    await tx.syncMemberRole.upsert({
      where: { teamId_accountId: { teamId: t.id, accountId: m.accountId } },
      update: { bizRole, deptId, dottedManagerId: dotted, changedAt: new Date(), by: accountId },
      create: { teamId: t.id, accountId: m.accountId, bizRole, deptId, dottedManagerId: dotted, by: accountId },
    });
    if (!是老板 && m.role !== 老角色(bizRole)) await tx.syncMember.update({ where: { teamId_accountId: { teamId: t.id, accountId: m.accountId } }, data: { role: 老角色(bizRole) } });
  });
  return { ok: true, bizRole, deptId };
}

/** 老接口「设业务主管 / 改回业务员」（老板用老版本桌面端）改了老角色：有角色行的跟着改，不然两边对不上 */
export async function 老角色改了(teamId: string, accountId: string, role: "manager" | "member") {
  const r = await control.syncMemberRole.findUnique({ where: { teamId_accountId: { teamId, accountId } } });
  if (r && 是业务角色(r.bizRole) && 老角色(r.bizRole) !== role) await control.syncMemberRole.update({ where: { teamId_accountId: { teamId, accountId } }, data: { bizRole: 推业务角色(false, role), changedAt: new Date() } });
}

/** 改「角色 × 范围」配置表的一格。字段级先只有 all */
export async function 设角色范围(accountId: string, teamId: string, bizRole: unknown, scope: unknown): Promise<结果<{ bizRole: 业务角色; scope: 数据范围 }>> {
  const t = await 能管(teamId, accountId);
  if (!t) return 错(403, 管不了);
  if (!是业务角色(bizRole)) return 错(400, "没有这个角色");
  if (!是数据范围(scope)) return 错(400, "没有这个范围");
  if (bizRole === "director" && accountId !== t.ownerAccountId) return 错(403, "只有老板能改总管理的范围");
  // 管理员不能把哪个角色放大成看全公司（本来默认就是全公司的除外，改回去照样行）
  if (scope === "all" && 默认范围[bizRole] !== "all" && accountId !== t.ownerAccountId) return 错(403, "只有老板能把范围设成全公司");
  await control.syncRoleScope.upsert({ where: { teamId_bizRole: { teamId: t.id, bizRole } }, update: { scope, changedAt: new Date(), by: accountId }, create: { teamId: t.id, bizRole, scope, by: accountId } });
  return { ok: true, bizRole, scope };
}

/** 我的团队() 带出去的编制：部门树、每人的部门和角色、配置表（老客户端不认这几项） */
export async function 编制给名单(teamId: string, ownerAccountId: string, 成员: { accountId: string; role: string }[]) {
  const 编制 = await 团队编制(teamId);
  const 顶 = 一级部门表(编制.depts);
  return {
    部门: 编制.depts.map((d) => ({ id: d.id, name: d.name, parentId: d.parentId, sort: d.sort, top: 顶.get(d.id) ?? null })),
    /** 没分部门的人、没负责人的客户算在这个一级部门（建得最早的）；部门筛选要和隔离一个口径 */
    默认: 默认一级部门(编制.depts),
    角色范围: 角色表.map((r) => ({ bizRole: r, scope: 编制.范围表[r] })),
    成员编制: Object.fromEntries(成员.map((m) => {
      const r = 编制.roles.get(m.accountId);
      return [m.accountId, { bizRole: 角色of(编制, m.accountId, m.accountId === ownerAccountId, m.role), deptId: r?.deptId ?? null, dottedManagerId: r?.dottedManagerId ?? null }];
    })),
  };
}

/**
 * 查重命中、跨部门搜到的那条标「内贸 / 外贸」：负责人所在的一级部门名。团队少于两个一级部门不标。
 * 和隔离（部门判定）一个口径：负责人没分部门、部门断链、已离队、没负责人的，都标默认一级部门
 */
export async function 一级部门名(teamId: string): Promise<(owner: string) => string | undefined> {
  const 编制 = await 团队编制(teamId);
  const 顶 = 一级部门表(编制.depts);
  if (new Set(顶.values()).size < 2) return () => undefined;
  const 名 = new Map(编制.depts.map((d) => [d.id, d.name]));
  const 默认 = 默认一级部门(编制.depts);
  const 在册 = new Set((await control.syncMember.findMany({ where: { teamId, leftAt: null }, select: { accountId: true } })).map((m) => m.accountId));
  return (owner) => {
    const id = owner.replace(/^acct_/, "");
    const d = 在册.has(id) ? 编制.roles.get(id)?.deptId : undefined;
    const top = (d && 顶.get(d)) || 默认;
    return top ? 名.get(top) : undefined;
  };
}

/* ---------------- 项目进组（通道①：负责人邀请，本人同意才算进组） ---------------- */

const 项目范围 = (s: unknown): s is string => typeof s === "string" && /^Project:[\w-]{1,100}$/.test(s);
/** label：发邀请那台用团队钥匙封好的项目名（中继读不到），被邀请的人还没有这个项目时靠它显示 */
const 封好的名对 = (s: unknown) => s === undefined || (typeof s === "string" && s.length <= 2000);

/** 邀请人：项目范围的负责人（项目负责人、客户负责人）或老板 */
export async function 邀请进组(accountId: string, teamId: string, scopeId: unknown, 谁: unknown, groupRole: unknown, label: unknown): Promise<结果<object>> {
  if (!项目范围(scopeId) || !封好的名对(label)) return 错(400, "邀请格式不对");
  if (groupRole !== undefined && groupRole !== null && (typeof groupRole !== "string" || groupRole.length > 40)) return 错(400, "组员角色不对");
  const t = await control.syncTeam.findUnique({ where: { id: String(teamId ?? "") } });
  const 我 = t && (await control.syncMember.findFirst({ where: { teamId: t.id, accountId, leftAt: null } }));
  if (!t || !我) return 错(403, "你不在这个团队里");
  const 他 = await control.syncMember.findFirst({ where: { teamId: t.id, accountId: String(谁 ?? ""), leftAt: null } });
  if (!他) return 错(404, "这个人已经不在团队里了");
  const scope = (await 团队索引(t.id)).groups.get(scopeId);
  if (!scope) return 错(404, "这个项目还没同步上来，稍后再邀请");
  if (t.ownerAccountId !== accountId && !scope.scope.owners.includes(`acct_${accountId}`)) return 错(403, "只有项目负责人能邀请人进组");
  if (scope.scope.owners.includes(`acct_${他.accountId}`)) return 错(409, "他本来就是这个项目的负责人");
  const 旧 = await control.syncProjectInvite.findUnique({ where: { teamId_scopeId_accountId: { teamId: t.id, scopeId, accountId: 他.accountId } } });
  if (旧?.status === "accepted") return 错(409, "他已经在组里了");
  const data = { groupRole: (groupRole as string | null | undefined) ?? null, status: "pending", invitedBy: accountId, label: (label as string | undefined) ?? null, createdAt: new Date(), answeredAt: null };
  await control.syncProjectInvite.upsert({ where: { teamId_scopeId_accountId: { teamId: t.id, scopeId, accountId: 他.accountId } }, update: data, create: { teamId: t.id, scopeId, accountId: 他.accountId, ...data } });
  return { ok: true };
}

/** 被邀请的人同意 / 拒绝。同意后下一轮同步目录里就有这个项目（含子表），不管在哪个部门 */
export async function 回邀请(accountId: string, teamId: string, scopeId: unknown, 同意: unknown): Promise<结果<{ status: string }>> {
  if (!项目范围(scopeId) || typeof 同意 !== "boolean") return 错(400, "格式不对");
  const r = await control.syncProjectInvite.findUnique({ where: { teamId_scopeId_accountId: { teamId: String(teamId ?? ""), scopeId, accountId } } });
  if (!r || r.status !== "pending") return 错(404, "邀请已经撤回或者回过了");
  if (!(await control.syncMember.findFirst({ where: { teamId: r.teamId, accountId, leftAt: null } }))) return 错(403, "你不在这个团队里");
  const status = 同意 ? "accepted" : "declined";
  await control.syncProjectInvite.update({ where: { teamId_scopeId_accountId: { teamId: r.teamId, scopeId, accountId } }, data: { status, answeredAt: new Date() } });
  return { ok: true, status };
}

/** 移出组 / 撤回邀请（负责人、老板），或者自己退出。移出后下一轮同步按「清理失权副本」删掉本机那份 */
export async function 移出组(accountId: string, teamId: string, scopeId: unknown, 谁: unknown): Promise<结果<object>> {
  if (!项目范围(scopeId)) return 错(400, "格式不对");
  const t = await control.syncTeam.findUnique({ where: { id: String(teamId ?? "") } });
  if (!t) return 错(404, "团队不存在");
  const 他 = String(谁 ?? "");
  if (他 !== accountId && t.ownerAccountId !== accountId) {
    const scope = (await 团队索引(t.id)).groups.get(scopeId);
    if (!scope?.scope.owners.includes(`acct_${accountId}`)) return 错(403, "只有项目负责人能移出组员");
  }
  const r = await control.syncProjectInvite.findUnique({ where: { teamId_scopeId_accountId: { teamId: t.id, scopeId, accountId: 他 } } });
  if (!r || r.status === "removed" || r.status === "declined") return { ok: true };
  await control.syncProjectInvite.update({ where: { teamId_scopeId_accountId: { teamId: t.id, scopeId, accountId: 他 } }, data: { status: "removed", answeredAt: new Date() } });
  return { ok: true };
}

/** 我收到的、还没回的邀请 + 我是负责人的项目的组员（含待同意的）。项目名是封好的，桌面端自己解 */
export async function 进组名单(accountId: string, teamId: string): Promise<结果<{ 待我回: object[]; 组员: object[] }>> {
  const t = await control.syncTeam.findUnique({ where: { id: String(teamId ?? "") } });
  if (!t || !(await control.syncMember.findFirst({ where: { teamId: t.id, accountId, leftAt: null } }))) return 错(403, "你不在这个团队里");
  const 待 = await control.syncProjectInvite.findMany({ where: { teamId: t.id, accountId, status: "pending" }, orderBy: { createdAt: "desc" }, take: 200 });
  const e = await 团队索引(t.id);
  const 我的项目 = [...e.groups.values()].filter((g) => g.id.startsWith("Project:") && (t.ownerAccountId === accountId || g.scope.owners.includes(`acct_${accountId}`))).map((g) => g.id);
  const 组 = 我的项目.length ? await control.syncProjectInvite.findMany({ where: { teamId: t.id, scopeId: { in: 我的项目.slice(0, 2000) }, status: { in: ["pending", "accepted"] } } }) : [];
  const 出 = (x: (typeof 待)[number]) => ({ scopeId: x.scopeId, accountId: x.accountId, groupRole: x.groupRole, status: x.status, invitedBy: x.invitedBy, label: x.label, createdAt: x.createdAt.toISOString() });
  return { ok: true, 待我回: 待.map(出), 组员: 组.map(出) };
}
