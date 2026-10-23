/**
 * 团队版项目模式 1b（2026-10-23）：部门、业务角色、「角色 × 范围」配置表。只有纯函数，云端（sync-scoped）和测试都用。
 *
 * 隔离按「一级部门」算，由云端按负责人所在的部门推，不往密文里写（不加路由字段：老客户端的 核对范围 会把多一个字段的包当成伪造）：
 * - 客户：销售 / 渠道负责人所在的一级部门，两人分在两个部门时两边都算；
 * - 没有负责人、负责人不在任何部门（老成员没分部门、已经离队）的：算团队默认的一级部门（建得最早的那个）；
 * - 公海客户照旧带着放进公海前的负责人（pool-actions），所以跟原部门走。
 * 团队只有 0 / 1 个一级部门时不隔离：老团队升级前后人人看到的数据完全一样。
 */
import type { 范围 } from "./scope-policy";

export const 业务角色 = ["director", "admin", "sales_mgr", "sales", "channel_ops", "marketing_mgr", "project_ops"] as const;
export type 业务角色 = (typeof 业务角色)[number];
export const 角色名: Record<业务角色, string> = {
  director: "总管理", admin: "管理员", sales_mgr: "销售管理", sales: "销售成员",
  channel_ops: "渠道运营", marketing_mgr: "市场管理", project_ops: "项目运营",
};
/**
 * 数据范围：本人 / 本人 + 互看开关 / 本一级部门 / 全公司。
 * 「本人 + 直属下属」（self_reports）只列在选项里，这一版不实现（直属上级的权限没定稿），设了按「本人」算
 */
export const 数据范围 = ["self", "self_share", "dept", "all", "self_reports"] as const;
export type 数据范围 = (typeof 数据范围)[number];
export const 范围名: Record<数据范围, string> = {
  self: "本人", self_share: "本人（团队开了互看时看同事）", dept: "本一级部门", all: "全公司", self_reports: "本人 + 直属下属（暂未开放）",
};
/**
 * 默认值 = 现在的行为（只有一个一级部门时）：老板 → 总管理看全部；主管 → 销售管理看本部门（= 全队）；业务员 → 销售成员看自己 + 互看开关。
 * 管理员按 10-23 拍板也默认看全公司（「配置表里能改」）；渠道运营、市场管理、项目运营同销售成员
 */
export const 默认范围: Record<业务角色, 数据范围> = {
  director: "all", admin: "all", sales_mgr: "dept", sales: "self_share", channel_ops: "self_share", marketing_mgr: "self_share", project_ops: "self_share",
};
/** 能建部门、调人、改角色和配置表的角色（建团队的人永远能） */
export const 能管人 = new Set<业务角色>(["director", "admin"]);
export const 是业务角色 = (x: unknown): x is 业务角色 => (业务角色 as readonly string[]).includes(x as string);
export const 是数据范围 = (x: unknown): x is 数据范围 => (数据范围 as readonly string[]).includes(x as string);

/** 老角色（SyncMember.role）→ 业务角色：老团队没有 SyncMemberRole 行时这样推 */
export function 推业务角色(建的人: boolean, 老角色: string | null | undefined): 业务角色 {
  return 建的人 ? "director" : 老角色 === "manager" ? "sales_mgr" : "sales";
}
/** 业务角色 → 老角色：设业务角色时同步写回 SyncMember.role，老客户端按名单对本机角色、照旧能用 */
export const 老角色 = (r: 业务角色): "manager" | "member" => (r === "sales_mgr" || r === "admin" || r === "director" ? "manager" : "member");

export type 部门行 = { id: string; parentId: string | null; createdAt: Date | string; sort?: number };
export const 部门最多层数 = 3;

/** 部门 → 它的一级部门（顺着 parentId 往上走；断链、成环的算不在任何部门） */
export function 一级部门表(depts: readonly 部门行[]): Map<string, string> {
  const by = new Map(depts.map((d) => [d.id, d]));
  const out = new Map<string, string>();
  for (const d of depts) {
    let cur: 部门行 | undefined = d;
    for (let i = 0; cur && cur.parentId && i < 部门最多层数 + 2; i++) cur = by.get(cur.parentId);
    if (cur && !cur.parentId) out.set(d.id, cur.id);
  }
  return out;
}
/** 团队默认的一级部门：建得最早的（同一刻按 sort、id）。没有一级部门 = null */
export function 默认一级部门(depts: readonly 部门行[]): string | null {
  const tops = depts.filter((d) => !d.parentId).sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || (a.sort ?? 0) - (b.sort ?? 0) || a.id.localeCompare(b.id));
  return tops[0]?.id ?? null;
}

export type 部门判定 = (scope: 范围) => boolean;
export type 成员部门 = { accountId: string; deptId: string | null };
/**
 * 「这个范围在不在我的一级部门里」。返回 undefined = 不隔离：团队少于两个一级部门、或我是全公司范围。
 * 「team」范围（成员、设置、渠道、供应商）全队共用，永远算在。范围的负责人是本机用户编号 acct_<账号>
 */
export function 部门判定(o: { 我: string; 我的范围: 数据范围; depts: readonly 部门行[]; members: readonly 成员部门[] }): 部门判定 | undefined {
  if (o.我的范围 === "all") return undefined;
  const 顶 = 一级部门表(o.depts);
  if (new Set(顶.values()).size < 2) return undefined;
  const 默认 = 默认一级部门(o.depts);
  const 人顶 = new Map<string, string>();
  for (const m of o.members) {
    const t = (m.deptId && 顶.get(m.deptId)) || 默认;
    if (t) 人顶.set(`acct_${m.accountId}`, t);
  }
  const 我的 = 人顶.get(`acct_${o.我}`) ?? 默认;
  return (scope) => {
    if (scope.id === "team") return true;
    const 部门们 = scope.owners.map((x) => 人顶.get(x)).filter((x): x is string => !!x);
    return 部门们.length ? 部门们.includes(我的!) : 默认 === 我的;
  };
}

/**
 * 按数据范围给读写档（和原来 sync-scoped auth 回的三样同一套意思，外加部门判定）：
 * - all：读全队客户、全队客户能改（= 原来的业务主管）；
 * - dept：同上，限本一级部门；
 * - self_share：自己的 + 团队开了互看时同部门同事的（只许加跟进）；
 * - self / self_reports：只看自己的。
 * 公海客户各档都按部门限（团队只有一个一级部门时不限）
 */
export function 读写档(o: { 建的人: boolean; 范围: 数据范围; 互看开关: boolean; 部门?: 部门判定 }): { owner: boolean; manager: boolean; share: boolean; 部门?: 部门判定 } {
  if (o.建的人) return { owner: true, manager: false, share: o.互看开关 };
  if (o.范围 === "all") return { owner: false, manager: true, share: o.互看开关 };
  if (o.范围 === "dept") return { owner: false, manager: true, share: o.互看开关, 部门: o.部门 };
  if (o.范围 === "self_share") return { owner: false, manager: false, share: o.互看开关, 部门: o.部门 };
  return { owner: false, manager: false, share: false, 部门: o.部门 };
}

/** 云端发给桌面端的部门行（GET /api/sync/team 的 编制.部门）：top = 它的一级部门，断链、成环的是 null */
export type 编制部门 = { id: string; name: string; parentId: string | null; sort: number; top: string | null };

/** 部门树摊平成带层级的列表（按 sort、名字），成环 / 断链的（top 为 null）放最后、不缩进。设置卡片和客户列表的部门下拉共用 */
export function 摊平部门<T extends 编制部门>(部门: readonly T[]): { d: T; 层: number }[] {
  const 子 = new Map<string | null, T[]>();
  for (const d of 部门) {
    const k = d.top ? d.parentId : "__坏";
    子.set(k, [...(子.get(k) ?? []), d]);
  }
  const 排 = (xs: T[]) => [...xs].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "zh"));
  const 出: { d: T; 层: number }[] = [];
  const 走 = (p: string | null, 层: number) => {
    for (const d of 排(子.get(p) ?? [])) {
      出.push({ d, 层 });
      if (层 < 部门最多层数) 走(d.id, 层 + 1);
    }
  };
  走(null, 1);
  for (const d of 排(子.get("__坏") ?? [])) 出.push({ d, 层: 1 });
  return 出;
}

/**
 * 客户列表「按部门筛」（10-23 拍板：总管理默认看全公司，列表加部门筛选）：这个部门连下级里的人（账号）。
 * 和隔离一个口径（部门判定）：选的是默认一级部门时，没分部门、部门断链的人算在里面，负责人都不在团队里（没负责人、已离队）的客户也算——含无主
 */
export function 部门里的人(编制: { 部门: readonly 编制部门[]; 默认: string | null; 成员编制: Record<string, { deptId: string | null }> }, deptId: string): { 人: string[]; 全员: string[]; 含无主: boolean } {
  const by = new Map(编制.部门.map((d) => [d.id, d]));
  const 在下面 = (id: string | null) => {
    for (let cur = id, i = 0; cur && i < 部门最多层数 + 2; i++) {
      if (cur === deptId) return true;
      cur = by.get(cur)?.parentId ?? null;
    }
    return false;
  };
  const 是默认 = !!编制.默认 && deptId === 编制.默认;
  const 全员 = Object.keys(编制.成员编制);
  const 人 = 全员.filter((a) => {
    const d = 编制.成员编制[a].deptId;
    const 有顶 = !!d && !!by.get(d)?.top;
    return 有顶 ? 在下面(d) : 是默认;
  });
  return { 人, 全员, 含无主: 是默认 };
}
