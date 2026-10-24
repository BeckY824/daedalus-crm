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
 * 纯函数在上半截（设置页、测试直接用），下半截读库。
 */
import { 是业务角色, type 业务角色 } from "@/lib/sync/dept-policy";

export const 字段 = {
  电话: { 名: "电话 / WhatsApp", 用在: "客户、联系人、线索", 能藏: true },
  销售负责人: { 名: "销售负责人", 用在: "客户", 能藏: false },
  渠道负责人: { 名: "渠道负责人", 用在: "客户", 能藏: false },
  跟进状态: { 名: "跟进状态", 用在: "客户", 能藏: false },
  决策状态: { 名: "决策状态", 用在: "客户", 能藏: false },
  预计签约: { 名: "预计签约时间", 用在: "客户", 能藏: false },
  客户备注: { 名: "备注", 用在: "客户", 能藏: false },
  商机金额: { 名: "金额", 用在: "商机", 能藏: false },
  商机阶段: { 名: "阶段", 用在: "商机", 能藏: false },
  商机负责人: { 名: "负责人", 用在: "商机", 能藏: false },
} as const;
export type 字段名 = keyof typeof 字段;
export const 字段名们 = Object.keys(字段) as 字段名[];

export type 字段级别 = "改" | "看" | "藏";
export type 字段配置 = Partial<Record<字段名, Partial<Record<业务角色, "看" | "藏">>>>;

export const 字段权限key = "enterprise.field_perm";

/** 客户表的列 → 字段权限里的字段（saveCustomer / patchCustomer 用）；外贸档案的 WhatsApp 也是号码 */
export const 客户列字段: Record<string, 字段名> = {
  phone: "电话",
  whatsapp: "电话",
  salesOwnerId: "销售负责人",
  channelOwnerId: "渠道负责人",
  followStatus: "跟进状态",
  decisionStatus: "决策状态",
  expectedSignAt: "预计签约",
  remark: "客户备注",
};

/** 存的、交来的配置都过一遍：不认识的字段、角色、级别丢掉；不能藏的字段写了「藏」按「看」 */
export function 规整字段配置(x: unknown): 字段配置 {
  const out: 字段配置 = {};
  if (!x || typeof x !== "object") return out;
  for (const [f, 格] of Object.entries(x as Record<string, unknown>)) {
    if (!Object.hasOwn(字段, f) || !格 || typeof 格 !== "object") continue;
    const 名 = f as 字段名;
    const 行: Partial<Record<业务角色, "看" | "藏">> = {};
    for (const [r, v] of Object.entries(格 as Record<string, unknown>)) {
      if (!是业务角色(r) || (v !== "看" && v !== "藏")) continue;
      行[r] = v === "藏" && !字段[名].能藏 ? "看" : v;
    }
    if (Object.keys(行).length) out[名] = 行;
  }
  return out;
}

export function 字段级别of(配置: 字段配置, 名: 字段名, 角色: 业务角色): 字段级别 {
  return 配置[名]?.[角色] ?? "改";
}

/** 这几个字段里有改不了的，说哪几个；都能改 = null */
export function 改不了的话(级别: (名: 字段名) => 字段级别, 名们: readonly 字段名[]): string | null {
  const 挡 = [...new Set(名们)].filter((n) => 级别(n) !== "改");
  return 挡.length ? `你的角色不能改「${挡.map((n) => 字段[n].名).join("」「")}」（设置 → 组织架构 → 字段权限）` : null;
}

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
