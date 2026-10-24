/**
 * 企业版组织架构（2026-10-24）：部门、业务角色、直属 / 虚线上级、下属。
 *
 * 数据在租户库的 EntDept / EntMember（迁移 044）。团队版的同一套概念在控制库（lib/sync/dept-policy.ts），
 * 角色取值、部门层数沿用那边的，规则不另起一套。
 *
 * 纯函数在 org-core.ts（测试和 Prisma 那一层直接用），这里转出去；最下面几个 async 的从库里读——
 * 别的模块要「谁是他直属上级」只调那几个，别自己查表。
 * 只管「组织里谁是谁」；规则生不生效（企业版() && 规则开关）由调用方判断。
 */
import { prisma } from "@/lib/prisma";
import { 建组织, 直属上级of, 虚线上级of, 管理员类别of, type 组织, type 管理员类别 as 类别 } from "./org-core";

export * from "./org-core";
// 部门树在 org-tree.ts（客户端组件也用，不能带 prisma）；这里转出去，服务端照旧从 org 拿
export { 部门树, type 组织部门 } from "./org-tree";

/** 从库里读整张组织表。二三十人的公司，一次全读比逐条查省事也更快 */
export async function 读组织(): Promise<组织> {
  const [users, members, depts] = await Promise.all([
    prisma.user.findMany({ select: { id: true, role: true, active: true } }),
    prisma.entMember.findMany(),
    prisma.entDept.findMany({ select: { id: true, name: true, parentId: true, sort: true } }),
  ]);
  return 建组织(users, members, depts);
}

export const 直属上级 = async (userId: string): Promise<string | null> => 直属上级of(await 读组织(), userId);
export const 虚线上级 = async (userId: string): Promise<string | null> => 虚线上级of(await 读组织(), userId);
// 类型和读库的函数同名（老写法），类型在这里再转一次
export type 管理员类别 = 类别;
export const 管理员类别 = async (userId: string): Promise<类别 | null> => 管理员类别of(await 读组织(), userId);
