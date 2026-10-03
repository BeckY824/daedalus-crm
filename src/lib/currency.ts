/**
 * 币种（2026-10-03）。全站都给，不只外贸模版——用户：「币种要增加，不止美元……做基本上热门的币种」。
 * 选哪些、为什么，见 ~/CRM/外贸CRM模版-2026-10-03/币种调研.md：内置 25 种分三组，其余走浏览器自带的 ISO 4217 全量。
 *
 * **不做汇率换算**：一单美元一单欧元加在一起是假数字。合计一律按币种分开（见 按币种合计）。
 * 显示交给 Intl：zh-CN 下会自己区分 US$ / AU$ / CA$ / HK$ / ¥ / JP¥ / €，小数位也跟着币种走（JPY、KRW 没有小数）。
 * 这个文件不碰数据库，客户端、服务端都能引。
 */

export const 默认币种 = "CNY";

/** 内置的那 25 种，下拉里按这三组排 */
export const 币种分组: { 组: string; 码: string[] }[] = [
  { 组: "常用", 码: ["USD", "EUR", "CNY", "GBP", "JPY", "HKD"] },
  { 组: "发达市场", 码: ["AUD", "CAD", "SGD", "CHF", "NZD", "KRW"] },
  { 组: "新兴市场", 码: ["RUB", "AED", "SAR", "INR", "THB", "MYR", "IDR", "VND", "PHP", "BRL", "MXN", "TRY", "ZAR"] },
];
export const 内置币种: string[] = 币种分组.flatMap((g) => g.码);

/**
 * 中文名。内置的 25 种写死——Intl.DisplayNames 在不同 Node / Chromium 版本里叫法不一样
 * （「阿联酋迪拉姆」「阿拉伯联合酋长国迪拉姆」），下拉里同一个币种两台机器两个名字很怪。
 * 内置以外的才交给 Intl。
 */
const 中文名表: Record<string, string> = {
  USD: "美元", EUR: "欧元", CNY: "人民币", GBP: "英镑", JPY: "日元", HKD: "港币",
  AUD: "澳元", CAD: "加元", SGD: "新加坡元", CHF: "瑞士法郎", NZD: "新西兰元", KRW: "韩元",
  RUB: "卢布", AED: "阿联酋迪拉姆", SAR: "沙特里亚尔", INR: "印度卢比", THB: "泰铢", MYR: "马来西亚林吉特",
  IDR: "印尼盾", VND: "越南盾", PHP: "菲律宾比索", BRL: "巴西雷亚尔", MXN: "墨西哥比索", TRY: "土耳其里拉", ZAR: "南非兰特",
};

/** 合法的币种代码：三位大写字母、Intl 认得。认不得的一律当不存在（落库前用它挡） */
export function 是币种(v: unknown): v is string {
  if (typeof v !== "string" || !/^[A-Z]{3}$/.test(v)) return false;
  if (中文名表[v]) return true;
  try {
    new Intl.NumberFormat("zh-CN", { style: "currency", currency: v });
    return 全部币种().includes(v);
  } catch {
    return false;
  }
}

/** 规整：小写、带空格的都认；认不得就退回 兜底（默认人民币——老数据没有币种就是人民币） */
export function 规整币种(v: unknown, 兜底 = 默认币种): string {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return 是币种(s) ? s : 兜底;
}

let 全量缓存: string[] | null = null;
/** 浏览器 / Node 认得的全部 ISO 4217 币种（「其他币种…」那一组用）。老环境没有这个 API 就只给内置的 */
export function 全部币种(): string[] {
  if (全量缓存) return 全量缓存;
  const 取 = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  全量缓存 = typeof 取 === "function" ? 取("currency") : [...内置币种];
  return 全量缓存;
}

export function 币种名(码: string): string {
  if (中文名表[码]) return 中文名表[码];
  try {
    return new Intl.DisplayNames(["zh-CN"], { type: "currency" }).of(码) ?? 码;
  } catch {
    return 码;
  }
}

/** 下拉里那一行：「USD 美元」 */
export function 币种标签(码: string): string {
  return `${码} ${币种名(码)}`;
}

/** 下拉选项：最近用过的排最前，接着三组内置，最后「其他」。给 antd Select 的 options 直接用 */
export function 币种选项(最近: string[] = []): { label: string; options: { value: string; label: string }[] }[] {
  const 近 = 最近.filter(是币种).filter((c, i, a) => a.indexOf(c) === i).slice(0, 4);
  const 行 = (c: string) => ({ value: c, label: 币种标签(c) });
  const 组 = 币种分组.map((g) => ({ label: g.组, options: g.码.filter((c) => !近.includes(c)).map(行) }));
  const 其他 = 全部币种().filter((c) => !内置币种.includes(c) && !近.includes(c)).map(行);
  return [...(近.length ? [{ label: "最近用过", options: 近.map(行) }] : []), ...组, ...(其他.length ? [{ label: "其他币种", options: 其他 }] : [])];
}

const 格式器 = new Map<string, Intl.NumberFormat>();
/**
 * 「US$ 18,600」「€ 21,500.50」「¥ 4,860,000」「JP¥ 120,000」。
 * 整数金额不显示 .00；有小数的按币种自己的小数位（美元两位、日元没有）。
 * 符号和数字之间留一个空格，和原来 money() 的「¥ 4,860,000」长得一样。
 */
export function 金额(n: number | null | undefined, 币种: string = 默认币种): string {
  const 码 = 规整币种(币种);
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  const 整 = Number.isInteger(v);
  const key = `${码}:${整 ? 0 : 1}`;
  let f = 格式器.get(key);
  if (!f) {
    f = new Intl.NumberFormat("zh-CN", { style: "currency", currency: 码, ...(整 ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}) });
    格式器.set(key, f);
  }
  // Intl 在 zh-CN 下符号和数字之间没有空格（US$18,600）；插一个，和老样子对齐。负号放最前
  const parts = f.formatToParts(v);
  const 号 = parts.filter((p) => p.type === "currency").map((p) => p.value).join("");
  const 负 = parts.some((p) => p.type === "minusSign") ? "-" : "";
  const 数 = parts.filter((p) => p.type !== "currency" && p.type !== "minusSign" && p.type !== "literal").map((p) => p.value).join("");
  return `${负}${号} ${数}`;
}

/** 金额框前面那个符号：CNY「¥」、USD「US$」、EUR「€」。和 金额() 显示的同一个 */
export function 币种符号(币种: string = 默认币种): string {
  const 码 = 规整币种(币种);
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: 码 }).formatToParts(0).filter((p) => p.type === "currency").map((p) => p.value).join("") || 码;
}

/**
 * 按币种合计：[{ 币种: "USD", 合计: 32100 }, { 币种: "EUR", 合计: 21500 }]，金额大的币种排前。
 * **不换汇**——这是这个文件最要紧的一条规矩。只有一种币时就一项，界面上和原来长得一样。
 */
export function 按币种合计<T>(行: T[], 取金额: (r: T) => number | null | undefined, 取币种: (r: T) => string | null | undefined): { 币种: string; 合计: number }[] {
  const m = new Map<string, number>();
  for (const r of 行) {
    const 码 = 规整币种(取币种(r));
    m.set(码, (m.get(码) ?? 0) + (Number(取金额(r)) || 0));
  }
  return [...m.entries()].map(([币种, 合计]) => ({ 币种, 合计 })).sort((a, b) => b.合计 - a.合计);
}

export type 币种合计 = { 币种: string; 合计: number };

/** 一份按币种的合计里，某个币种是多少（没有就是 0）。画图、排序这种只能用一个数的地方，取本位币那一份 */
export function 取币种(合计: 币种合计[], 币种: string): number {
  return 合计.find((x) => x.币种 === 规整币种(币种))?.合计 ?? 0;
}

/** 几份按币种的合计再加在一起（漏斗各档 → 合计那一行） */
export function 合并合计(...份: 币种合计[][]): 币种合计[] {
  return 按币种合计(份.flat(), (x) => x.合计, (x) => x.币种);
}

/**
 * 两份合计之间的环比（%）。**只在两边都是同一个币种时算**：
 * 上月全是人民币、本月来了一单美元，拿两个数一比就是假涨幅。上月是 0、币种不一样都返回 undefined（不显示）。
 */
export function 同币环比(本: 币种合计[], 上: 币种合计[]): number | undefined {
  if (本.length > 1 || 上.length !== 1) return undefined;
  const 上值 = 上[0].合计;
  if (!上值) return undefined;
  if (本.length === 1 && 本[0].币种 !== 上[0].币种) return undefined;
  const 本值 = 本[0]?.合计 ?? 0;
  return Number((((本值 - 上值) / 上值) * 100).toFixed(1));
}

/** 「US$ 32,100 · € 21,500」。空的时候按本位币写 0 */
export function 合计文字(合计: { 币种: string; 合计: number }[], 本位币: string = 默认币种): string {
  if (合计.length === 0) return 金额(0, 本位币);
  return 合计.map((x) => 金额(x.合计, x.币种)).join(" · ");
}
