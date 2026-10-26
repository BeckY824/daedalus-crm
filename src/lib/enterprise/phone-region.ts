/**
 * 企业版建档的号码归属地（2026-10-26，测试清单 B7）：选「手机号」查重时顺带显示——
 * 国内手机号显示省、市、运营商；国外号（+ 开头、不是 +86）显示国家；邮箱 / 微信 / 旺旺 / 二维码不查。
 *
 * 全离线：私有部署可能不能联网，不调任何接口。
 * - 国内：phone-region-data.ts（前 7 位 → 省市 + 运营商，scripts/make-phone-region.py 从 phone.dat 生成，
 *   数据来源和许可证见那个脚本的头注）。只看号段，携号转网以后的运营商认不出来（号段表都这样）
 * - 国外：libphonenumber-js（已有依赖）认国家，中文名和扫名片同一张叫法表
 *
 * 只在服务端用（node:zlib 解压，第一次查的时候解一次、常驻内存约 1MB）。开关关着不被调，见 number-actions.ts
 */
import { inflateSync } from "node:zlib";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { 国家名 } from "@/lib/card-scan/form";
import { 游程, 城市表 } from "./phone-region-data";

/** phone.dat 的运营商代号 → 叫法（0 = 数据里没标，不显示） */
const 运营商们 = ["", "中国移动", "中国联通", "中国电信", "中国电信（虚拟运营商）", "中国联通（虚拟运营商）", "中国移动（虚拟运营商）", "中国广电"] as const;

export type 国内归属 = { 国内: true; 省: string; 市: string; 运营商: string; 文字: string };
export type 国外归属 = { 国内: false; 国家: string; 文字: string };
export type 归属地 = 国内归属 | 国外归属;

const 起号段 = 1300000;
let 表: { 起: Int32Array; 值: Uint16Array } | null = null;

/** 解开游程表：起[i] = 第 i 段的第一个前 7 位，值[i] = 城市序号 * 8 + 运营商（0xFFFF 没数据） */
function 号段表() {
  if (表) return 表;
  const b = inflateSync(Buffer.from(游程, "base64"));
  const 起们: number[] = [];
  const 值们: number[] = [];
  let 号 = 起号段;
  for (let i = 0; i < b.length; ) {
    let 长 = 0;
    for (let 移 = 0; ; 移 += 7) {
      const x = b[i++];
      长 |= (x & 0x7f) << 移;
      if (!(x & 0x80)) break;
    }
    起们.push(号);
    值们.push(b[i] | (b[i + 1] << 8));
    i += 2;
    号 += 长;
  }
  起们.push(号); // 哨兵：最后一段的尾
  表 = { 起: Int32Array.from(起们), 值: Uint16Array.from(值们) };
  return 表;
}

/** 前 7 位落在哪一段（二分：最后一个 起 ≤ 前缀 的段） */
function 查段(前缀: number): number | null {
  const { 起, 值 } = 号段表();
  if (前缀 < 起[0] || 前缀 >= 起[起.length - 1]) return null;
  let lo = 0;
  let hi = 值.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (起[mid] <= 前缀) lo = mid;
    else hi = mid - 1;
  }
  return 值[lo] === 0xffff ? null : 值[lo];
}

/** 国内 11 位手机号 → 省市运营商。号段表里没有的（新放的号段、不是手机号）回 null */
export function 国内归属地(号: string): 国内归属 | null {
  if (!/^1\d{10}$/.test(号)) return null;
  const v = 查段(Number(号.slice(0, 7)));
  if (v == null) return null;
  const [省 = "", 市 = ""] = (城市表[v >> 3] ?? "").split("|");
  const 运营商 = 运营商们[v & 7] ?? "";
  // 直辖市省市同名，只写一遍：「北京 中国移动」「广东 深圳 中国联通」
  const 地 = 省 === 市 || !市 ? 省 : `${省} ${市}`;
  return { 国内: true, 省, 市, 运营商, 文字: [地, 运营商].filter(Boolean).join(" ") };
}

/** 国外号（+ 开头）→ 国家。认不出国家的回 null（不猜） */
export function 国外归属地(号: string): 国外归属 | null {
  const p = parsePhoneNumberFromString(号.startsWith("+") ? 号 : `+${号}`);
  let 码 = p?.country;
  if (!码) return null;
  // 英国的海峡群岛、马恩岛号码算英国（和 research/verify/country 的 同一国 一个意思）
  if (码 === "GG" || 码 === "JE" || 码 === "IM") 码 = "GB";
  const 国家 = 国家名(码);
  return 国家 ? { 国内: false, 国家, 文字: 国家 } : null;
}

/**
 * 号码归属地：只有「手机号」类型查；值是 验号码 规整过的（国内 11 位，国外带 +）。其他类型一律 null
 */
export function 号码归属地(类型: string, 值: string): 归属地 | null {
  if (类型 !== "手机号" || !值) return null;
  if (值.startsWith("+")) return 国外归属地(值);
  return 国内归属地(值);
}
