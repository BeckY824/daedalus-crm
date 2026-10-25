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
import type { Prisma } from "@/generated/prisma";
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

/** 不参与自动分配的人：Setting 里存 JSON string[]，没存 = 人人参与。设置 → 组织架构 →「线索分配」里每人一个开关 */
export const 自动分配不参与key = "enterprise.lead_assign.auto_excluded";

export type 候选人 = { userId: string; 已分: number; 配额: number | null; 进池: Date };

/**
 * 自动分配挑谁（D-38）：去掉不参与的、（这一条算数时）分满的，挑本月已分最少的；
 * 一样多给最早进分配池的。EntMember 没记进池时间，先按建号时间算；再一样按 id，结果不随查询顺序变
 */
export function 挑接手人(候选: 候选人[], 不参与: ReadonlySet<string>, 查满: boolean): string | null {
  const 可 = 候选.filter((c) => !不参与.has(c.userId) && !(查满 && 满了(c.已分, c.配额)));
  可.sort((a, b) => a.已分 - b.已分 || a.进池.getTime() - b.进池.getTime() || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  return 可[0]?.userId ?? null;
}

/**
 * 挑中 谁 的理由，给界面上的结果提示用（「为什么是他」）。和 挑接手人 用同一套筛法：
 * 这一条不算数时不看配额；并列最少时说明是按进池先后给的
 */
export function 挑的理由(候选: 候选人[], 不参与: ReadonlySet<string>, 查满: boolean, 谁: string): string {
  const 可 = 候选.filter((c) => !不参与.has(c.userId) && !(查满 && 满了(c.已分, c.配额)));
  const 他 = 可.find((c) => c.userId === 谁);
  if (!他) return "";
  const 并列 = 可.filter((c) => c.已分 === 他.已分).length;
  const 理由 = 并列 > 1 ? `本月已分最少（${他.已分} 条，和 ${并列 - 1} 人并列，先给最早进分配池的）` : `本月已分最少（${他.已分} 条）`;
  return 查满 ? 理由 : `${理由}；这条不算数，不看配额`;
}

/** 能改「参与自动分配」开关的人（Q-12 默认）：老板、总管理员、销售管理；直属上级只能看 */
export function 能改参与(org: 组织, 我: { id: string; role: string }): boolean {
  if (我.role === "ADMIN") return true;
  const 类 = 管理员类别of(org, 我.id);
  return 类 === "总管理员" || 类 === "销售管理";
}

// —— 读库 ——

/** 查完再写 的事务里传 tx 进来，查的和写的落在同一个事务 */
type 库 = Pick<Prisma.TransactionClient, "entLeadAssign" | "entLeadQuota">;

/** 本月已经算进数的分配条数 */
export async function 本月已分(userId: string, 月 = 月份(), db: 库 = prisma): Promise<number> {
  return db.entLeadAssign.count({ where: { toUserId: userId, month: 月, counted: true } });
}

export async function 配额of(userId: string, db: 库 = prisma): Promise<number | null> {
  return (await db.entLeadQuota.findUnique({ where: { userId } }))?.quota ?? null;
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
