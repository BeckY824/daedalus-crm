/**
 * 企业版线索分配（2026-10-24 会上定的，规则「线索分配和配额」，默认关）。
 *
 * - 营销线索可以分给内贸销售，也可以分给外贸销售：分的时候选走哪条线，接手人的业务线要对得上（没填业务线 = 两边都做）。
 * - 分配数按月算、每月清零：每分一次在 EntLeadAssign 记一行，带 month（YYYY-MM），配额只数本月那一格。
 *   销售自己拓的线索没有分配记录，自然不算。
 * - 直属上级、虚线上级（以及总管理员、老板）能给个人设每月配额，不设固定复核周期；没设 = 不限。
 * - 线索分出去以后，原来的负责人（市场人员）仍能看到转化情况：记录里留了 fromUserId，
 *   「我分出去的线索」按它查，不受「按组织架构看客户」限定。
 * - **还没定的留口子**：营销企划线索走哪边、算不算数——kind 记下来，算不算数走 计不计数()，
 *   现在先和营销线索一样算，定了以后改这一处（或拨 企划线索计数key 那个 Setting）。
 *
 * 纯函数在上半截（测试直接用），下半截读写库。权限、规则开关的检查在 leads/assign-actions.ts。
 */
import { prisma, defaultClient } from "@/lib/prisma";
import { 管理员类别of, 直属上级of, 虚线上级of, type 组织 } from "./org-core";

export const 线索种类 = ["营销", "营销企划"] as const;
export type 线索种类 = (typeof 线索种类)[number];
export type 线 = "内贸" | "外贸";

/** 营销企划线索算不算进当月分配数：Setting 里存 JSON true / false，没存 = 算（10-24 计数细节未定，先和营销线索一样） */
export const 企划线索计数key = "enterprise.lead_assign.plan_counted";

/** 本月是哪一格：按服务器本地时间（企业版部署包里 TZ 默认 Asia/Shanghai），月初零点换格 = 每月清零 */
export function 月份(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** 能接分配线索的业务角色：销售、销售管理 */
const 能接的角色 = new Set(["sales", "sales_mgr"]);

/** 能点「分配」的人：老板（账号管理员）、总管理员、市场管理 */
export function 能分配(org: 组织, 我: { id: string; role: string }): boolean {
  if (我.role === "ADMIN") return true;
  const 类 = 管理员类别of(org, 我.id);
  return 类 === "总管理员" || 类 === "市场管理";
}

/** 能给 目标 设配额的人：他的直属上级、虚线上级，或者老板、总管理员 */
export function 能设配额(org: 组织, 我: { id: string; role: string }, 目标: string): boolean {
  if (我.role === "ADMIN") return true;
  if (管理员类别of(org, 我.id) === "总管理员") return true;
  return 直属上级of(org, 目标) === 我.id || 虚线上级of(org, 目标) === 我.id;
}

/** 这条线索能不能分给 接手人：返回出错原因，null = 可以 */
export function 接手问题(org: 组织, 接手人: string, line: 线 | null): string | null {
  const m = org.成员.get(接手人);
  if (!m) return "接手人不在组织里，或者已经停用";
  if (!能接的角色.has(m.bizRole)) return "线索只能分给销售或销售管理";
  if (line && m.line && m.line !== line) return `他是${m.line}销售，这条线索走${line}`;
  return null;
}

/** 这一条分配算不算进接手人当月的数。营销企划怎么算还没定：先看 Setting，没设 = 算 */
export function 计不计数(kind: 线索种类, 企划算数: boolean | null): boolean {
  if (kind === "营销企划") return 企划算数 ?? true;
  return true;
}

/** 配额满了没：配额 null = 不限 */
export const 满了 = (已分: number, 配额: number | null) => 配额 !== null && 已分 >= 配额;

// —— 读库 ——

/** 本月已经算进数的分配条数 */
export async function 本月已分(userId: string, 月 = 月份()): Promise<number> {
  return prisma.entLeadAssign.count({ where: { toUserId: userId, month: 月, counted: true } });
}

export async function 配额of(userId: string): Promise<number | null> {
  return (await prisma.entLeadQuota.findUnique({ where: { userId } }))?.quota ?? null;
}

export type 分出去的线索 = {
  leadId: string;
  name: string;
  status: string;
  convertedAt: string | null;
  /** 转成了哪个客户；线索删了或没转 = null */
  customerId: string | null;
  接手人: string;
  当前负责人: string | null;
  line: string | null;
  kind: string;
  分配时间: string;
};

/**
 * 我分出去的线索和它们现在的转化情况（10-24：「线索分出去以后，原来的市场人员仍能看到转化情况」）。
 * 我 = 分之前的负责人（fromUserId）或者点分配的人（byUserId）。同一条线索分了几次只留最近一次。
 *
 * 线索走不限定的那个连接：分出去以后线索在别人名下，「按组织架构看客户」开着时我按负责人是看不到它的；
 * 这里只取名称、状态、转化时间这几列，不带电话、邮箱。
 */
export async function 我分出去的(我: string, 最多 = 200): Promise<分出去的线索[]> {
  const 记录 = await prisma.entLeadAssign.findMany({
    where: { OR: [{ fromUserId: 我 }, { byUserId: 我 }] },
    orderBy: { createdAt: "desc" },
    take: 最多 * 2,
  });
  const 最近 = new Map<string, (typeof 记录)[number]>();
  for (const r of 记录) if (!最近.has(r.leadId)) 最近.set(r.leadId, r);
  const ids = [...最近.keys()].slice(0, 最多);
  const leads = await defaultClient.lead.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, status: true, convertedAt: true, customerId: true, owner: { select: { name: true } } },
  });
  const 线索 = new Map(leads.map((l) => [l.id, l]));
  const 人名 = new Map(
    (await defaultClient.user.findMany({ where: { id: { in: [...new Set([...最近.values()].map((r) => r.toUserId))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
  );
  return ids.flatMap((id) => {
    const r = 最近.get(id)!;
    const l = 线索.get(id);
    if (!l) return []; // 线索被删了
    return [{
      leadId: id,
      name: l.name,
      status: l.status,
      convertedAt: l.convertedAt?.toISOString() ?? null,
      customerId: l.customerId,
      接手人: 人名.get(r.toUserId) ?? "—",
      当前负责人: l.owner?.name ?? null,
      line: r.line,
      kind: r.kind,
      分配时间: r.createdAt.toISOString(),
    }];
  });
}
