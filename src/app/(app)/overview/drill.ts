/**
 * 数据页明细的形状和「按人点进去」的挑法。不引库：ReportsView（客户端组件）也要用。
 */

/** 趋势图上点开一根柱子时看到的那几行：这一段是哪几笔签约凑出来的 */
export type 明细行 = {
  id: string; 学员: string; 学员id: string; 金额: number; 日期: string; 销售: string;
  /** 签约那一刻的销售 / 渠道负责人（和 bySales / byChannelOwner 同一个口径，T-030）。没有是 null */
  销售id: string | null;
  渠道负责人id: string | null;
};

/**
 * 「按销售负责人 / 按渠道负责人」那一行点进去看到的签约（T-030）。
 *
 * 原来点名字跳 `/customers?salesOwnerId=`：上面按**签约那一刻**的负责人、限了时间段和币种，
 * 点进去按**现在**的负责人、不限时间，人数对不上，老板一看就会问。
 * 明细已经按同一个口径送下来了，从里面挑这个人的就是那一行的数，一笔不多一笔不少。
 */
export function 按人明细(明细: Record<string, 明细行[]>, 维度: "销售" | "渠道负责人", id: string): 明细行[] {
  return Object.values(明细).flat().filter((r) => (维度 === "销售" ? r.销售id : r.渠道负责人id) === id);
}
