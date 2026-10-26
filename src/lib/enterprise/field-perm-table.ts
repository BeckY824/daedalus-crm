/**
 * 企业版字段权限的纯数据和纯函数（客户端组件也能 import：设置页的「角色 × 字段」表用）。
 *
 * 别在这里 import 任何服务端模块，动态 import 也不行：Turbopack 会顺着打进浏览器包，next build 报错。
 * 读库的 字段权限of / 挡字段 在 field-perm.ts，规则说明也在那边。
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

/**
 * 推荐表（清单 ② 的默认建议，10-25 定稿草案的 20 个 ★ 格；三张清单 A1：对方定之前先照这个跑）。
 * 不自动生效：设置页「字段权限」卡片点「用推荐表」填进草稿，保存后还要打开「字段权限」规则才管用。
 * 渠道运营、市场管理的「销售负责人」保持能改：分配给销售按这个字段拦，锁了就分不了线索。
 */
export const 推荐字段配置: 字段配置 = {
  电话: { project_ops: "看" },
  销售负责人: { project_ops: "看" },
  渠道负责人: { sales: "看", project_ops: "看" },
  跟进状态: { project_ops: "看" },
  决策状态: { channel_ops: "看", marketing_mgr: "看", project_ops: "看" },
  预计签约: { channel_ops: "看", marketing_mgr: "看", project_ops: "看" },
  商机金额: { channel_ops: "看", marketing_mgr: "看", project_ops: "看" },
  商机阶段: { channel_ops: "看", marketing_mgr: "看", project_ops: "看" },
  商机负责人: { channel_ops: "看", marketing_mgr: "看", project_ops: "看" },
};

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
