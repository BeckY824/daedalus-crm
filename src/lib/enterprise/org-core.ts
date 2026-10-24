/**
 * 企业版组织架构的纯函数（2026-10-24）：组织里谁是谁、谁管谁。
 *
 * 不碰数据库，所以 Prisma 那一层的限定（lib/enterprise/visibility.ts）也能直接用，不会绕回 lib/prisma.ts；
 * 从库里读组织在 org.ts。
 */
import { 是业务角色, 部门最多层数, type 业务角色, type 业务线 } from "@/lib/sync/dept-policy";
import type { 组织部门 } from "./org-tree";

export type 组织成员 = {
  userId: string;
  deptId: string | null;
  bizRole: 业务角色;
  line: 业务线 | null;
  managerId: string | null;
  dottedManagerId: string | null;
};
/** 只含在职（User.active）的人：停用的人不当任何人的上级，也不算谁的下属 */
export type 组织 = { 成员: Map<string, 组织成员>; 部门: Map<string, 组织部门> };

/** 没有 EntMember 行的人按账号角色推：管理员 → 总管理员，主管 → 销售管理，其余 → 销售 */
export function 推业务角色(账号角色: string | null | undefined): 业务角色 {
  return 账号角色 === "ADMIN" ? "director" : 账号角色 === "MANAGER" ? "sales_mgr" : "sales";
}

const 是业务线 = (x: unknown): x is 业务线 => x === "内贸" || x === "外贸";

export function 建组织(
  users: readonly { id: string; role: string; active: boolean }[],
  members: readonly { userId: string; deptId: string | null; bizRole: string; line: string | null; managerId: string | null; dottedManagerId: string | null }[],
  depts: readonly 组织部门[],
): 组织 {
  const 行 = new Map(members.map((m) => [m.userId, m]));
  const 部门 = new Map(depts.map((d) => [d.id, d]));
  const 成员 = new Map<string, 组织成员>();
  for (const u of users) {
    if (!u.active) continue;
    const m = 行.get(u.id);
    成员.set(u.id, {
      userId: u.id,
      // 部门被删了的当没分部门
      deptId: m?.deptId && 部门.has(m.deptId) ? m.deptId : null,
      bizRole: m && 是业务角色(m.bizRole) ? m.bizRole : 推业务角色(u.role),
      line: m && 是业务线(m.line) ? m.line : null,
      managerId: m?.managerId ?? null,
      dottedManagerId: m?.dottedManagerId ?? null,
    });
  }
  return { 成员, 部门 };
}

/**
 * 直属上级（10-24 定）：显式指定的优先；没指定（或指定的人停用了）就从本部门往上找销售管理。
 * - 自己就是销售管理的，从上一级部门开始找，同部门的另一个销售管理不算他的上级；
 * - 同一个部门有几个销售管理时取编号最小的那个，结果稳定；想指定谁就显式设 managerId；
 * - 一直找到顶都没有 = null（不往总管理员上兜：谁能代替直属上级做事由各条规则自己定）。
 */
export function 直属上级of(org: 组织, userId: string): string | null {
  const m = org.成员.get(userId);
  if (!m) return null;
  if (m.managerId && m.managerId !== userId && org.成员.has(m.managerId)) return m.managerId;

  let dept = m.deptId;
  if (m.bizRole === "sales_mgr" && dept) dept = org.部门.get(dept)?.parentId ?? null;
  // 多走两步兜住断链；成环的部门树走满步数就停
  for (let i = 0; dept && i < 部门最多层数 + 2; i++) {
    const 候选 = [...org.成员.values()]
      .filter((x) => x.deptId === dept && x.bizRole === "sales_mgr" && x.userId !== userId)
      .map((x) => x.userId)
      .sort();
    if (候选.length) return 候选[0];
    dept = org.部门.get(dept)?.parentId ?? null;
  }
  return null;
}

/** 虚线上级：只认显式指定的，停用了 = 没有 */
export function 虚线上级of(org: 组织, userId: string): string | null {
  const d = org.成员.get(userId)?.dottedManagerId;
  return d && d !== userId && org.成员.has(d) ? d : null;
}

/** 顺着「上级」往下走出所有下属（不含自己），成环不会转圈。层数 1 = 只要直接下属 */
function 下属(org: 组织, 上级of: (org: 组织, id: string) => string | null, 我: string, 层数: number): Set<string> {
  const 下面 = new Map<string, string[]>();
  for (const id of org.成员.keys()) {
    const up = 上级of(org, id);
    if (up) 下面.set(up, [...(下面.get(up) ?? []), id]);
  }
  const 结果 = new Set<string>();
  const 见过 = new Set([我]);
  let 这层 = [我];
  for (let 层 = 0; 层 < 层数 && 这层.length; 层++) {
    const 下层: string[] = [];
    for (const a of 这层) for (const b of 下面.get(a) ?? []) if (!见过.has(b)) { 见过.add(b); 结果.add(b); 下层.push(b); }
    这层 = 下层;
  }
  return 结果;
}

/** 实线下属：直属上级链往下，默认整条链 */
export const 实线下属 = (org: 组织, 我: string, 层数 = Infinity) => 下属(org, 直属上级of, 我, 层数);
/** 虚线下属：只顺虚线往下（A 虚线管 B、B 虚线管 C，A 也看 C），同团队版 虚线上级规则 */
export const 虚线下属 = (org: 组织, 我: string, 层数 = Infinity) => 下属(org, 虚线上级of, 我, 层数);

/** 企业版管理员三类（10-24）：销售管理 / 市场管理 / 总管理员；别的角色 = 不是管理员 */
export type 管理员类别 = "销售管理" | "市场管理" | "总管理员";
export function 管理员类别of(org: 组织, userId: string): 管理员类别 | null {
  const r = org.成员.get(userId)?.bizRole;
  if (r === "director" || r === "admin") return "总管理员";
  if (r === "sales_mgr") return "销售管理";
  if (r === "marketing_mgr") return "市场管理";
  return null;
}

/** 部门在第几层（一级部门 = 1，null = 顶上 = 0）；断链、成环 = Infinity */
export function 部门层数(部门: ReadonlyMap<string, 组织部门>, id: string | null): number {
  let n = 0;
  for (let cur = id; cur; cur = 部门.get(cur)!.parentId) {
    if (!部门.has(cur) || ++n > 部门最多层数 + 1) return Infinity;
  }
  return n;
}
/** 子树最深几层（自己 = 1）；成环的那一圈不往下走 */
function 子树深(部门: ReadonlyMap<string, 组织部门>, id: string, 见过 = new Set<string>()): number {
  见过.add(id);
  const 下面 = [...部门.values()].filter((d) => d.parentId === id && !见过.has(d.id));
  return 1 + Math.max(0, ...下面.map((d) => 子树深(部门, d.id, 见过)));
}

/**
 * 建部门（id = null）或把部门挪到 parentId 底下之前查一遍：返回出错原因，null = 可以。
 * 规则同团队版：挪完整棵子树仍不超过 部门最多层数 层、不能挪到自己或自己的下级部门底下。
 */
export function 部门挪动问题(部门: ReadonlyMap<string, 组织部门>, id: string | null, parentId: string | null): string | null {
  if (parentId && !部门.has(parentId)) return "上级部门不存在";
  if (id) {
    if (!部门.has(id)) return "部门不存在";
    for (let cur = parentId, i = 0; cur && i < 部门最多层数 + 2; cur = 部门.get(cur)?.parentId ?? null, i++) {
      if (cur === id) return "不能挪到自己或自己的下级部门底下";
    }
  }
  const 深 = id ? 子树深(部门, id) : 1;
  return 部门层数(部门, parentId) + 深 > 部门最多层数 ? `部门最多 ${部门最多层数} 层` : null;
}

/**
 * 给 userId 设直属 / 虚线上级之前查一遍：返回出错原因，null = 可以（上级 = null 是清掉，总是可以）。
 * 不能是自己、不能是停用的人、不能是自己（实线 / 虚线）链上的下属——否则上级链成环，谁也管不到谁。
 */
export function 上级设置问题(org: 组织, userId: string, 上级: string | null, 种类: "直属" | "虚线"): string | null {
  if (!上级) return null;
  if (!org.成员.has(userId)) return "这个人不在职";
  if (上级 === userId) return "上级不能是自己";
  if (!org.成员.has(上级)) return "选的上级不在职";
  const 下面 = 种类 === "直属" ? 实线下属(org, userId) : 虚线下属(org, userId);
  return 下面.has(上级) ? `选的人是他的${种类 === "直属" ? "" : "虚线"}下属，不能反过来当他的上级` : null;
}
