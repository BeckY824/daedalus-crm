/**
 * 对方自报的邮箱和电话：
 *   邮箱  和官网是不是一家（主域名比）、是不是免费邮箱、是不是仿冒官网的域名、这个域名能不能收信（MX）
 *   电话  libphonenumber（Google 开源库，本地判，不联网）：号码有效没有、哪国的、手机 / 固话 / 网络电话，
 *         和自报的国家对不对得上
 * 小公司用 Gmail、迪拜公司用英国手机号都很常见：只标黄并写清是哪两项对不上。**仿冒域名才标红**——那是骗子最典型的手法。
 */
import { resolveMx } from "node:dns/promises";
import { parsePhoneNumberFromString, type CountryCode, type NumberType } from "libphonenumber-js/max";
import { 主域名, 是免费邮箱, 比域名 } from "./domain";
import { 国名, 同一国 } from "./country";
import { 天数, type 域名年龄 } from "./rdap";
import type { 核验项, 灯 } from "./types";

const 灯序: Record<灯, number> = { gray: 0, green: 1, yellow: 2, red: 3 };
const 最坏 = (a: 灯, b: 灯): 灯 => (灯序[b] > 灯序[a] ? b : a);

export type 查MX = (域: string) => Promise<boolean | null>;

/** 有没有收信记录：有 true、确实没有 false、查不了 null */
export const 默认查MX: 查MX = async (域) => {
  try {
    const r = await Promise.race([resolveMx(域), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("超时")), 5000))]);
    return r.length > 0;
  } catch (e) {
    const code = (e as { code?: string }).code;
    return code === "ENOTFOUND" || code === "ENODATA" ? false : null;
  }
};

export async function 查邮箱(
  邮箱们: string[],
  官网域: string | undefined,
  依赖: { 查MX: 查MX; 查年龄: (域: string) => Promise<域名年龄> },
): Promise<核验项> {
  const 列 = [...new Set(邮箱们.map((x) => x.trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))].slice(0, 3);
  if (!列.length) return { key: "email", 灯: "gray", 态: "没提供", 事实: "没提供对方邮箱，未查" };
  let 总: 灯 = "gray";
  let 硬红: string | undefined;
  const 句: string[] = [];
  const 官 = 官网域 ? 主域名(官网域) : undefined;
  for (const 邮 of 列) {
    const 域 = 主域名(邮) ?? 邮.split("@")[1];
    if (是免费邮箱(邮)) {
      总 = 最坏(总, "yellow");
      句.push(`${邮}：免费邮箱${官 ? `，和官网 ${官} 不是一个域名` : ""}`);
      continue;
    }
    const mx = await 依赖.查MX(域);
    const 收信 = mx === false ? "，这个域名没有收信记录（MX）" : "";
    if (!官) {
      总 = 最坏(总, "yellow");
      句.push(`${邮}：企业邮箱 ${域}，没认出官网，没法比对${收信}`);
      continue;
    }
    const 关系 = 比域名(域, 官);
    if (关系 === "同一家") {
      总 = 最坏(总, mx === false ? "yellow" : "green");
      句.push(`${邮}：和官网同一个域名${mx === true ? "，能收信" : 收信}`);
      continue;
    }
    if (关系 === "无关") {
      总 = 最坏(总, "yellow");
      句.push(`${邮}：邮箱域名 ${域} 和官网 ${官} 不是一家${收信}`);
      continue;
    }
    // 像官网、又不是官网：看这个邮箱域名注册多久了。仿冒域名几乎都是新注册的；老域名多半是同一家在别国 / 别的品牌
    const 年 = await 依赖.查年龄(域).catch(() => ({ 有: false as const, 查不了: true }));
    // 存档 / 证书给的是下限：最早存档才一个月的域名，按新域名算也不冤
    const 天 = 年.有 ? 天数(年.日期) : null;
    const 门槛 = 关系 === "形近" ? 730 : 365;
    const 像 = 关系 === "形近" ? "只差一两个字母" : 关系 === "换后缀" ? "同名换了后缀" : "在官网名字上加了词";
    if (天 !== null && 天 < 门槛) {
      硬红 ??= `邮箱域名 ${域} 像是仿冒官网 ${官}（${像}，注册才 ${天} 天）`;
      总 = "red";
      句.push(`${邮}：${域} 和官网 ${官} ${像}，注册才 ${天} 天${收信}`);
    } else if (天 === null && 关系 === "形近") {
      硬红 ??= `邮箱域名 ${域} 像是仿冒官网 ${官}（${像}）`;
      总 = "red";
      句.push(`${邮}：${域} 和官网 ${官} ${像}，查不到注册时间${收信}`);
    } else {
      总 = 最坏(总, "yellow");
      句.push(`${邮}：${域} 和官网 ${官} ${像}${天 !== null ? `，已注册 ${Math.floor(天 / 365)} 年多，可能是同一家的另一个域名，确认一下` : "，确认一下是不是同一家"}${收信}`);
    }
  }
  return { key: "email", 灯: 总, 态: "已核", 事实: 句.join("；"), ...(硬红 ? { 硬红 } : {}) };
}

const 类型名: Partial<Record<NumberType & string, string>> = {
  MOBILE: "手机",
  FIXED_LINE: "固话",
  FIXED_LINE_OR_MOBILE: "固话或手机",
  TOLL_FREE: "免费电话",
  VOIP: "网络电话",
  PERSONAL_NUMBER: "个人转接号",
  PREMIUM_RATE: "付费号码",
  SHARED_COST: "分摊费用号码",
  UAN: "统一接入号",
  PAGER: "寻呼号",
  VOICEMAIL: "语音信箱",
};

/** 公司国家：电话不带 + 时按它解析；自报国家：拿来比归属国（没有就和公司国家比） */
export function 查电话(电话们: string[], 公司国家?: string, 自报国家?: string): 核验项 {
  const 列 = [...new Set(电话们.map((x) => x.trim()).filter((x) => x.replace(/\D/g, "").length >= 6))].slice(0, 3);
  if (!列.length) return { key: "phone", 灯: "gray", 态: "没提供", 事实: "没提供对方电话，未查" };
  const 比 = 自报国家 ?? 公司国家;
  const 比谁 = 自报国家 ? "自报的" : "公司所在的";
  let 总: 灯 = "gray";
  const 句: string[] = [];
  for (const raw of 列) {
    const n = parsePhoneNumberFromString(raw, (公司国家 as CountryCode | undefined) ?? undefined);
    if (!n || !n.isValid()) {
      总 = 最坏(总, "yellow");
      句.push(`${raw}：不是有效号码`);
      continue;
    }
    const 国 = n.country;
    const 类 = n.getType();
    const 类字 = (类 && 类型名[类]) ?? "号码";
    const 号 = n.formatInternational();
    const 怪类 = 类 === "VOIP" || 类 === "PERSONAL_NUMBER" || 类 === "PREMIUM_RATE";
    const 对不上 = 比 && 国 && !同一国(国, 比);
    总 = 最坏(总, 对不上 || 怪类 ? "yellow" : "green");
    句.push(`${号}：${国名(国)}${类字}${怪类 ? "（虚拟号段，常用来注册账号）" : ""}${对不上 ? `；和${比谁}${国名(比)}对不上` : ""}`);
  }
  return { key: "phone", 灯: 总, 态: "已核", 事实: 句.join("；") };
}
