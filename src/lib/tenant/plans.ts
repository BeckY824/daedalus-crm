/**
 * 套餐。按工作区收费，不按人头——小团队按人头算会在第三个人加入时开始纠结，
 * 而纠结的结果通常是不加人，反而让产品用不起来。
 *
 * 价格写在代码里而不是配置表：改价是一件需要同时改官网、改文案、通知老客户的事，
 * 让它走一次发布反而更安全。真要做多档促销时再抽出来。
 */
export const PLANS = {
  year: {
    label: "按年",
    price: 1980,
    unit: "年",
    badge: "省 2 个月",
    note: "一个工作区，人数不限，含全部 AI 功能",
    days: 365,
  },
  month: {
    label: "按月",
    price: 198,
    unit: "月",
    badge: "",
    note: "随时停，按自然月计算",
    days: 31,
  },
} as const;

export type PlanKey = keyof typeof PLANS;

export function isPlanKey(v: unknown): v is PlanKey {
  return typeof v === "string" && v in PLANS;
}
