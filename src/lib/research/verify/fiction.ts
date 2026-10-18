/**
 * 留给影视剧 / 示例用的虚构号段（10-18 复核：Anna 那个 020 7946 0123 是 Ofcom 留给影视剧的号段，
 * 有家公司官网恰好拿它当占位符，我们就认成了那家公司，真实性还亮了绿灯）。
 * 这种号码不会分给任何人：电话那一项亮红、写明「这是虚构号码」，也不拿它去认公司。
 *
 * 英国：Ofcom「Telephone numbers for use in TV and radio drama」全表
 *   https://www.ofcom.org.uk/phones-and-broadband/phone-numbers/numbers-for-drama （10-18 核对过）
 * 北美：NANP 留给虚构用的 555-0100 到 555-0199
 * 本地判，不联网。
 */
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";

/** 英国号段，按「去掉开头 0 的本国号码」比；每段 1000 个号 */
const 英国: { 前缀: string; 位数: number; 名: string }[] = [
  ...(
    [
      ["113", "利兹"],
      ["114", "谢菲尔德"],
      ["115", "诺丁汉"],
      ["116", "莱斯特"],
      ["117", "布里斯托"],
      ["118", "雷丁"],
      ["121", "伯明翰"],
      ["131", "爱丁堡"],
      ["141", "格拉斯哥"],
      ["151", "利物浦"],
      ["161", "曼彻斯特"],
    ] as const
  ).map(([区, 名]) => ({ 前缀: `${区}4960`, 位数: 10, 名: `${名} 0${区} 496 0xxx` })),
  { 前缀: "1914980", 位数: 10, 名: "泰恩赛德 0191 498 0xxx" },
  { 前缀: "2079460", 位数: 10, 名: "伦敦 020 7946 0xxx" },
  { 前缀: "2896496", 位数: 10, 名: "北爱尔兰 028 9649 6xxx" },
  { 前缀: "2920180", 位数: 10, 名: "加的夫 029 2018 0xxx" },
  { 前缀: "1632960", 位数: 10, 名: "无地区 01632 960xxx" },
  { 前缀: "7700900", 位数: 10, 名: "手机 07700 900xxx" },
  { 前缀: "8081570", 位数: 10, 名: "免费电话 08081 570xxx" },
  { 前缀: "9098790", 位数: 10, 名: "付费电话 0909 879 0xxx" },
  { 前缀: "3069990", 位数: 10, 名: "全国 03069 990xxx" },
];

/**
 * 号码落在虚构号段里就返回一句说明（「Ofcom 留给影视剧的虚构号段（伦敦 020 7946 0xxx）」），否则 null。
 * 国家码（「44」「1」）+ 本体（不带国家码、不带开头 0 的本国号码）
 */
export function 虚构号段(国家码: string, 本体: string): string | null {
  const d = 本体.replace(/\D/g, "").replace(/^0+/, "");
  if (国家码 === "44") {
    const 段 = 英国.find((x) => d.length === x.位数 && d.startsWith(x.前缀));
    return 段 ? `Ofcom 留给影视剧的虚构号段（${段.名}）` : null;
  }
  // 北美各国共用 +1：区号 3 位 + 555 01xx
  if (国家码 === "1" && /^\d{3}55501\d{2}$/.test(d)) return "北美留给影视剧的虚构号段（555-0100 到 555-0199）";
  return null;
}

/** 一串原样写的号码（「+44 20 7946 0123」，或带 默认国家 的「020 7946 0123」）是不是虚构号码 */
export function 是虚构号码(raw: string, 默认国家?: string): string | null {
  const n = parsePhoneNumberFromString(raw.trim(), (默认国家 as CountryCode | undefined) ?? undefined);
  return n ? 虚构号段(String(n.countryCallingCode), String(n.nationalNumber)) : null;
}
