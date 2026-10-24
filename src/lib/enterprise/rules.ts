/**
 * 企业版组织规则的开关表（2026-10-24）。
 *
 * 每条规则一个 Setting 开关，默认关；生效 = 企业版() 开着 **且** 自己的开关开着。
 * 开关存在租户库 Setting 表（值是 JSON true / false），设置 → 组织架构里由老板、总管理员拨。
 *
 * 这里只放纯数据，别 import prisma：visibility.ts 在 Prisma 钩子里用这张表，带上 prisma 就绕回自己了。
 */
import { 企业版 } from "./switch";

export const 规则 = {
  按组织看客户: {
    key: "enterprise.rule.org_scope",
    名: "按组织架构看客户",
    说明: "开了以后：销售只看自己的客户和公海；直属上级看、改整条下属链的客户；虚线上级只能看，不能改、不能转。老板、总管理员照旧看全部。",
  },
} as const;

export type 规则名 = keyof typeof 规则;

/** 规则现在生不生效（服务端用；钩子里别调，钩子里直接读 Setting 行） */
export async function 规则开着(名: 规则名): Promise<boolean> {
  if (!企业版()) return false;
  const { getSetting } = await import("@/lib/settings");
  return (await getSetting<boolean>(规则[名].key)) === true;
}
