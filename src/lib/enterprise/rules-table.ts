/**
 * 企业版组织规则的开关表（纯数据，客户端组件也能 import）。
 *
 * 别在这里 import 任何服务端模块，动态 import 也不行：Turbopack 会顺着打进浏览器包
 * （settings → prisma → next/headers），next build 直接报错。读开关的 规则开着 在 rules.ts。
 */
export const 规则 = {
  按组织看客户: {
    key: "enterprise.rule.org_scope",
    名: "按组织架构看客户",
    说明: "开了以后：销售只看自己的客户和公海；直属上级看、改整条下属链的客户；虚线上级只能看，不能改、不能转。老板、总管理员照旧看全部。",
  },
} as const;

export type 规则名 = keyof typeof 规则;
