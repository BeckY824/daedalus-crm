/**
 * 企业版字段权限（2026-10-24 会上：「做『角色 × 字段』配置表，默认值保持现在的行为」；哪个角色管哪些字段还没定）。
 *
 * 规则「字段权限」开着才生效（lib/enterprise/rules.ts，默认关）。配置存 Setting `enterprise.field_perm`，
 * 只存和默认不一样的格：{ 字段: { 业务角色: "看" | "藏" } }，没写的格 = 能改（就是现在的行为）。
 * - 「看」= 看得到、改不了；「藏」= 看不到。
 * - 现在只有电话能藏：页面、导出、AI 助手、MCP 出号码都过 号码脱敏器 这一个出口（lib/shared-ws/current.ts），在那里打码。
 *   别的字段要藏得一页页改，等清单定了再加，表里先只给「改 / 看」。
 * - 老板（账号管理员）不受限，免得把自己锁在外面。
 *
 * 纯数据和纯函数在 field-perm-table.ts（设置页客户端组件 import 那个），这里 re-export 再加读库的两个。
 */
import type { 业务角色 } from "@/lib/sync/dept-policy";
import { 字段权限key, 字段级别of, 规整字段配置, 改不了的话, type 字段名, type 字段级别 } from "./field-perm-table";

export * from "./field-perm-table";

// —— 读库 ——

const 全能改 = (): 字段级别 => "改";

/**
 * 这个人的字段级别查询器。规则没开、企业版没开、老板、没登录 → 全是「改」（现在的行为）。
 * 组织里没登记的人按账号角色推业务角色（org-core 推业务角色），照推出来的角色查表。
 * userId 不给 = 当前登录的人。
 */
export async function 字段权限of(userId?: string | null): Promise<(名: 字段名) => 字段级别> {
  const { 规则开着 } = await import("./rules");
  if (!(await 规则开着("字段权限"))) return 全能改;
  const { prisma } = await import("@/lib/prisma");
  const id = userId === undefined ? (await (await import("@/lib/auth")).getCurrentUser())?.id ?? null : userId;
  if (!id) return 全能改;
  const u = await prisma.user.findUnique({ where: { id }, select: { role: true } });
  if (!u || u.role === "ADMIN") return 全能改;
  const { 读组织 } = await import("./org");
  const 角色 = (await 读组织()).成员.get(id)?.bizRole;
  if (!角色) return 全能改;
  const { getSetting } = await import("@/lib/settings");
  const 配置 = 规整字段配置(await getSetting<unknown>(字段权限key));
  return (名) => 字段级别of(配置, 名, 角色);
}

/** 写之前查：这次要动的字段里有改不了的就给那句话，都能改 = null */
export async function 挡字段(userId: string, 名们: readonly 字段名[]): Promise<string | null> {
  if (!名们.length) return null;
  return 改不了的话(await 字段权限of(userId), 名们);
}
