import { businessDayjs } from "./business-clock";
/**
 * 供应商比价的规则（2026-10-03 外贸第 3c 块）。不碰数据库，客户端和服务端都能引。
 * 依据：~/CRM/外贸CRM模版-2026-10-03/外贸CRM模版.md 第三节。
 */
import { 产品键 } from "./quote";

export const 结论们 = ["待定", "选用", "备选", "淘汰"] as const;
export type 结论 = (typeof 结论们)[number];
/** 这两种结论必须写理由：选了谁、为什么不要谁，是比价表上唯一给老板看的那一格 */
export const 要理由: readonly string[] = ["选用", "淘汰"];

export const 评级们 = [
  { value: "A", label: "A 稳定" },
  { value: "B", label: "B 可用" },
  { value: "C", label: "C 慎用" },
] as const;

/** 一个询盘至少问几家：少于这个数，比价抽屉顶上提醒一句 */
export const 至少问几家 = 2;

type 比价行 = { id: string; product: string; unitPrice: number; currency: string; withInvoice: boolean; verdict?: string };

/**
 * 同一个产品、同币种、同含票口径里最低价的那几行（并列都算）。
 * 口径不同不比：含 13% 票的价和不含票的价摆在一起比，便宜的那个多半是没算票。淘汰了的不参与。
 */
export function 最低价(行: 比价行[]): Set<string> {
  const 组 = new Map<string, 比价行[]>();
  for (const r of 行) {
    if (!(r.unitPrice > 0) || r.verdict === "淘汰") continue;
    const k = `${产品键(r.product)}|${r.currency}|${r.withInvoice ? 1 : 0}`;
    组.set(k, [...(组.get(k) ?? []), r]);
  }
  const 出 = new Set<string>();
  for (const rs of 组.values()) {
    if (rs.length < 2) continue; // 只有一家谈不上「最低」
    const 低 = Math.min(...rs.map((r) => r.unitPrice));
    for (const r of rs) if (r.unitPrice === 低) 出.add(r.id);
  }
  return 出;
}

/**
 * 建议报价：出厂价 ÷ 汇率 ÷ (1 − 目标毛利率)，运费另算（外贸CRM模版.md 3.1 的公式）。
 * 汇率 = 1 单位报价币种折多少采购币种（1 USD = 7.1 CNY 就是 7.1）。参数不对返回 null，不出一个吓人的数
 */
export function 建议报价(出厂价: number, 汇率: number | null | undefined, 毛利率: number | null | undefined): number | null {
  if (!(出厂价 > 0) || !汇率 || !(汇率 > 0)) return null;
  const 率 = 毛利率 ?? 0;
  if (!(率 >= 0 && 率 < 1)) return null;
  return Math.round((出厂价 / 汇率 / (1 - 率)) * 10000) / 10000;
}

/**
 * 一单的毛利（按采购币种）：收入 = 订单金额 × 汇率；毛利 = 收入 − 采购额；毛利率 = 毛利 ÷ 收入。
 * 订单币种和采购币种一样时汇率就是 1，不用填。缺一样就算不出来，返回 null。
 */
export function 毛利(o: { amount: number; currency: string }, 采: { cost: number; currency: string; fxRate: number | null } | null): { 毛利: number; 毛利率: number; 币种: string } | null {
  if (!采 || !(采.cost > 0) || !(o.amount > 0)) return null;
  const 汇率 = o.currency === 采.currency ? 1 : 采.fxRate;
  if (!汇率 || !(汇率 > 0)) return null;
  const 收入 = o.amount * 汇率;
  const 利 = Math.round((收入 - 采.cost) * 100) / 100;
  return { 毛利: 利, 毛利率: Math.round((利 / 收入) * 1000) / 10, 币种: 采.currency };
}

/** 报价过了有效期：过期的那一行变灰，提醒「这个价不一定还作数」 */
export function 过期了(validUntil: string | Date | null | undefined, 现在: Date = new Date()): boolean {
  if (!validUntil) return false;
  return businessDayjs(validUntil).format("YYYY-MM-DD") < businessDayjs(现在).format("YYYY-MM-DD");
}
