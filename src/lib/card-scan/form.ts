/**
 * 扫名片认出来的字段 → 手机新建客户表单（2026-10-19）。纯函数，单测在 tests/card-scan.test.ts。
 *
 * - 外贸：名字格先放公司（列表里认的是公司），人名 + 职位进备注；通用模版反过来，名字放人名
 * - 表单没有的（职位、地址、其他电话、名片上没归类的字）一律进备注，不丢
 * - 拿不准的格子（OCR 置信度 < 0.9、邮箱和官网域名对不上、号码核实不了）标黄
 * - 次入口「拍名片自动填」：已经填了的格子不覆盖，只补空格（补到备注是接在后面）
 */
import type { 字段 } from "./parse";

export type 名片表单 = { name: string; phone: string; whatsapp: string; email: string; wechat: string; website: string; country: string; remark: string };
export type 名片填法 = {
  填: 名片表单;
  /** 标黄的格子 */
  黄: (keyof 名片表单)[];
  /** 名字格下面「换成 …」：公司 / 人名另一个、双语名片的另一种写法 */
  名字候选: string[];
  /** 名片上没写 WhatsApp：建议用手机号（人点一下才填） */
  whatsapp建议: string | null;
};

export const 空名片表单 = (): 名片表单 => ({ name: "", phone: "", whatsapp: "", email: "", wechat: "", website: "", country: "", remark: "" });

/** 名片上认出的国家（ISO 两位）→ 表单里的叫法（和 lib/customer-extra 国家候选一致；没列的退回浏览器的中文名） */
const 国家叫法: Record<string, string> = {
  CN: "中国", HK: "中国香港", TW: "中国台湾", MO: "中国澳门", US: "美国", CA: "加拿大", GB: "英国", DE: "德国", FR: "法国", IT: "意大利", ES: "西班牙",
  NL: "荷兰", BE: "比利时", PL: "波兰", SE: "瑞典", CH: "瑞士", AT: "奥地利", IE: "爱尔兰", PT: "葡萄牙", GR: "希腊", CZ: "捷克", RO: "罗马尼亚",
  HU: "匈牙利", DK: "丹麦", NO: "挪威", FI: "芬兰", UA: "乌克兰", RU: "俄罗斯", AE: "阿联酋", SA: "沙特阿拉伯", QA: "卡塔尔", KW: "科威特",
  OM: "阿曼", BH: "巴林", IL: "以色列", JO: "约旦", IQ: "伊拉克", IR: "伊朗", TR: "土耳其", EG: "埃及", UZ: "乌兹别克斯坦", KZ: "哈萨克斯坦",
  KG: "吉尔吉斯斯坦", TJ: "塔吉克斯坦", TM: "土库曼斯坦", GE: "格鲁吉亚", AZ: "阿塞拜疆", AM: "亚美尼亚", AF: "阿富汗", PK: "巴基斯坦",
  JP: "日本", KR: "韩国", IN: "印度", VN: "越南", TH: "泰国", MY: "马来西亚", SG: "新加坡", ID: "印度尼西亚", PH: "菲律宾", MM: "缅甸",
  KH: "柬埔寨", BD: "孟加拉国", LK: "斯里兰卡", NP: "尼泊尔", MN: "蒙古", AU: "澳大利亚", NZ: "新西兰", MX: "墨西哥", BR: "巴西",
  AR: "阿根廷", CL: "智利", PE: "秘鲁", CO: "哥伦比亚", EC: "厄瓜多尔", VE: "委内瑞拉", PA: "巴拿马", CR: "哥斯达黎加", DO: "多米尼加",
  UY: "乌拉圭", PY: "巴拉圭", BO: "玻利维亚", ZA: "南非", NG: "尼日利亚", KE: "肯尼亚", ET: "埃塞俄比亚", GH: "加纳", TZ: "坦桑尼亚",
  MA: "摩洛哥", DZ: "阿尔及利亚", TN: "突尼斯", LY: "利比亚", AO: "安哥拉", UG: "乌干达", CI: "科特迪瓦", SN: "塞内加尔", CM: "喀麦隆", SD: "苏丹",
};

export function 国家名(iso: string | null | undefined): string {
  const k = String(iso ?? "").trim().toUpperCase();
  if (!k) return "";
  if (国家叫法[k]) return 国家叫法[k];
  try { return new Intl.DisplayNames(["zh-CN"], { type: "region" }).of(k) ?? ""; } catch { return ""; }
}

export function 名片转表单(f: 字段, 外贸: boolean): 名片填法 {
  const 填 = 空名片表单();
  const 黄 = new Set<keyof 名片表单>();
  const 备注: string[] = [];
  const 人 = f.name?.trim() || "";
  const 公司 = f.company?.trim() || "";
  const 职位 = f.title?.trim() || "";

  // 名字：外贸先公司，通用先人名；另一个进备注，也给「换成」
  const 先 = 外贸 ? 公司 || 人 : 人 || 公司;
  填.name = 先 || f.name建议?.trim() || "";
  if (f.待核.includes(先 === 公司 ? "company" : "name")) 黄.add("name");
  if (!先 && f.name建议) 黄.add("name");
  if (先 === 公司 && 人) 备注.push(`联系人：${人}${职位 ? `（${职位}）` : ""}`);
  else if (先 === 人 && 公司) 备注.push(`公司：${公司}${职位 ? ` · ${职位}` : ""}`);
  else if (职位) 备注.push(`职位：${职位}`);
  const 名字候选 = [...new Set([公司, 人, ...f.companyAlt, ...f.nameAlt].map((x) => x?.trim()).filter((x): x is string => Boolean(x) && x !== 填.name))].slice(0, 3);

  // 电话：手机优先；明写了 WhatsApp 的进 WhatsApp；剩下的（座机、传真、第二个手机）进备注
  const 号们 = f.phones.filter((p) => p.类 !== "WhatsApp");
  const 主 = 号们.find((p) => p.类 === "手机") ?? 号们.find((p) => p.类 !== "传真") ?? null;
  if (主) { 填.phone = 主.e164; if (!主.核实 || f.待核.includes("phones")) 黄.add("phone"); }
  const wa = f.whatsapp ?? f.phones.find((p) => p.类 === "WhatsApp")?.e164 ?? null;
  if (外贸 && wa) 填.whatsapp = wa;
  for (const p of f.phones) {
    if (p === 主 || p.e164 === 主?.e164 || (外贸 && p.e164 === wa)) continue;
    备注.push(`${p.类 === "不确定" ? "电话" : p.类}：${p.e164}`);
  }
  // 通用模版没有 WhatsApp / 邮箱 / 微信 / 官网 / 国家几格：都进备注
  if (外贸) {
    填.email = f.email ?? "";
    填.wechat = f.wechat ?? "";
    填.website = f.website ?? "";
    填.country = 国家名(f.country);
    for (const k of ["email", "website", "country"] as const) if (f.待核.includes(k) && 填[k]) 黄.add(k);
    if (f.待核.includes("wechat") && 填.wechat) 黄.add("wechat");
  } else {
    if (!主 && wa) 填.phone = wa;
    if (f.email) 备注.push(`邮箱：${f.email}`);
    if (f.wechat) 备注.push(`微信：${f.wechat}`);
    if (f.website) 备注.push(`官网：${f.website}`);
  }
  if (f.address) 备注.push(`地址：${f.address}`);
  if (f.剩下.length) 备注.push(`名片上还有：${f.剩下.join(" / ")}`);
  填.remark = 备注.join("\n");
  if (["address", "title"].some((k) => f.待核.includes(k)) && 填.remark) 黄.add("remark");

  const 手机 = 号们.find((p) => p.类 === "手机");
  return { 填, 黄: [...黄], 名字候选, whatsapp建议: 外贸 && !填.whatsapp && (f.whatsapp建议 || 手机?.e164) ? f.whatsapp建议 || 手机!.e164 : null };
}

/** 次入口：已经填了的格子不覆盖，只补空的；备注接在后面。返回补上了哪几格（只这几格标黄才有意义） */
export function 只补空格(原: 名片表单, 新: 名片表单): { 填: 名片表单; 补了: (keyof 名片表单)[] } {
  const 填 = { ...原 };
  const 补了: (keyof 名片表单)[] = [];
  for (const k of Object.keys(新) as (keyof 名片表单)[]) {
    const v = 新[k].trim();
    if (!v) continue;
    if (k === "remark") {
      if (!原.remark.includes(v)) { 填.remark = 原.remark.trim() ? `${原.remark.trim()}\n${v}` : v; 补了.push(k); }
    } else if (!原[k].trim()) { 填[k] = v; 补了.push(k); }
  }
  return { 填, 补了 };
}
