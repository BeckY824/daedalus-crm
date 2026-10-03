/**
 * 外贸订单的规则（2026-10-03 外贸第 3a 块）。不碰数据库，客户端和服务端都能引。
 * 依据：~/CRM/外贸CRM模版-2026-10-03/外贸CRM模版.md 第一节（12 节点）、2.8（单据）、2.9（回款）。
 *
 * 节点三条规矩（和配套 Excel 一样）：
 *   1. 每个节点只有「截止日 + 状态」。截止日过了还没完成就红，3 天内到期就黄；其余信息写进跟进记录
 *   2. 「不适用」是一等公民：EXW 不订舱、全款不分定金尾款……标了就不参与超期和进度
 *   3. 「当前节点」= 第一个既没完成也不是不适用的，算出来、不让人手填
 */

export const 节点名们 = [
  "询盘",
  "找供应商（比价）",
  "报价",
  "客户确认（PI）",
  "收定金",
  "下单给工厂",
  "生产跟进",
  "验货 / 货好",
  "订舱",
  "装柜",
  "报关 / 开船",
  "单据 · 尾款 · 放单",
] as const;

/** 前四个节点是商机那一段（询盘 → 客户确认），从赢单的商机生成订单时它们已经走完了 */
export const 成交前节点数 = 4;

export const 节点状态们 = ["未开始", "进行中", "已完成", "卡住", "不适用"] as const;
export type 节点状态 = (typeof 节点状态们)[number];

export const 贸易条款们 = ["EXW", "FCA", "FOB", "CFR", "CIF", "DAP", "DDP"] as const;
export const 常用付款方式 = ["T/T 30/70", "T/T 100% 前", "L/C at sight", "D/P", "PayPal", "阿里信保"];

export const 单据状态们 = ["未收", "已收", "已发客户", "不需要"] as const;
export type 单据状态 = (typeof 单据状态们)[number];

/**
 * 按贸易条款默认要收的单据（2.8 那张表）。「选」「客户要才要」的不默认列，要的人自己加一行。
 * 没写条款时按 FOB：小贸易公司最常见。
 */
export function 默认单据(incoterm?: string | null): string[] {
  const 条 = (incoterm ?? "FOB").toUpperCase();
  const 出口自己办 = 条 !== "EXW"; // EXW 客户自己提货：不订舱、不报关、不出提单
  const 我方投保 = 条 === "CIF" || 条 === "DAP" || 条 === "DDP";
  return [
    "报价单 Quotation",
    "形式发票 PI（客户签回）",
    "定金水单",
    "采购合同",
    ...(出口自己办 ? ["订舱单 S/O"] : []),
    "装箱单 PL",
    "商业发票 CI",
    ...(出口自己办 ? ["报关单", "提单 B/L"] : []),
    ...(我方投保 ? ["保险单"] : []),
    "尾款水单",
  ];
}

export type 节点 = { idx: number; name: string; dueAt: string | null; status: string; doneAt?: string | null };

const 不算 = (n: Pick<节点, "status">) => n.status === "已完成" || n.status === "不适用";

/** 当前节点：第一个既没完成也不是不适用的。全走完了返回 null（这单结束了） */
export function 当前节点<T extends Pick<节点, "status" | "idx">>(nodes: T[]): T | null {
  return [...nodes].sort((a, b) => a.idx - b.idx).find((n) => !不算(n)) ?? null;
}

/** 本地日期的「今天零点」。超期按日历天算：截止日当天还不算超期 */
function 零点(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export type 灯 = "红" | "黄" | "绿" | "灰" | "无";

/**
 * 一格的颜色：
 *   已完成 → 绿；不适用 → 灰；
 *   没完成、截止日在今天之前 → 红（超期）；卡住 → 红；
 *   没完成、截止日在 3 天内（含今天）→ 黄；
 *   其余 → 无（没排日子，或者还早）
 */
export function 节点灯(n: Pick<节点, "status" | "dueAt">, 现在: Date = new Date()): 灯 {
  if (n.status === "已完成") return "绿";
  if (n.status === "不适用") return "灰";
  if (n.status === "卡住") return "红";
  if (!n.dueAt) return "无";
  const 差天 = Math.round((零点(new Date(n.dueAt)) - 零点(现在)) / 86400000);
  if (差天 < 0) return "红";
  if (差天 <= 3) return "黄";
  return "无";
}

/** 超期了几个节点（卡住也算：都是「这一步出问题了」） */
export function 超期数(nodes: Pick<节点, "status" | "dueAt">[], 现在: Date = new Date()): number {
  return nodes.filter((n) => 节点灯(n, 现在) === "红").length;
}

/** 进度 %：完成的 ÷ 适用的（不适用的不进分母）。一个都不适用就当 100 */
export function 进度(nodes: Pick<节点, "status">[]): number {
  const 适用 = nodes.filter((n) => n.status !== "不适用");
  if (!适用.length) return 100;
  return Math.round((适用.filter((n) => n.status === "已完成").length / 适用.length) * 100);
}

/** 钱：尾款应收 = 金额 - 定金应收；未收 = 金额 - 定金实收 - 尾款实收（不小于 0） */
export function 订单的钱(o: { amount: number; depositDue: number; depositPaid: number; balancePaid: number }) {
  const 尾款应收 = Math.max(0, Math.round((o.amount - o.depositDue) * 100) / 100);
  const 未收 = Math.max(0, Math.round((o.amount - o.depositPaid - o.balancePaid) * 100) / 100);
  return { 尾款应收, 未收 };
}

/**
 * 订单号默认「年月日-序号」：20261003-1。和 DDW 那种「国家缩写 + 年月日 + 序号」比少了国家——
 * 客户国家我们不一定有；人可以自己改成 PI 号。`今天已有` 是今天已经用掉的号（同一天第二单就是 -2）。
 */
export function 默认订单号(今天已有: string[], 现在: Date = new Date()): string {
  const 日 = `${现在.getFullYear()}${String(现在.getMonth() + 1).padStart(2, "0")}${String(现在.getDate()).padStart(2, "0")}`;
  let n = 1;
  while (今天已有.includes(`${日}-${n}`)) n++;
  return `${日}-${n}`;
}
