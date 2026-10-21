/**
 * 扫名片的 AI 整理（2026-10-20 用户在总控定：「用 AI，免费不扣次数」，只给团队版）。
 *
 * 规则（parse.ts）照旧先拆一遍；AI 只做规则做不好的两件事：
 *   1. 哪几行是公司、联系人、职位、地址、标语（AI 只回行号，**不许改写原文**，字段的值一律从 OCR 那一行拿）
 *   2. 外文（不是中文也不是英文）的公司、人名、职位、地址给中文译文，原文保留
 * 电话、邮箱、网址、微信、WhatsApp、国家照旧用规则：AI 碰不到号码，就编不出号码。
 * AI 超时、报错、回的东西不对 → 用规则的结果，人看到的和没有 AI 时一样。
 *
 * 这个文件两头都用：服务器拼提示词、验回答（app/api/mobile/scan/ai），手机把回答合进字段（合AI）。别 import 服务器的东西
 */
import { 排好的行, 文字, 修后缀, type 框, type 字段 } from "./parse";

/** 一行给 AI 看的样子：行号、原文、字号（0–10）、左中右；电话 / 邮箱 / 网址那几行规则已经认了，标上「联系方式」 */
export type 名片行 = { i: number; text: string; 字号: number; 位: "左" | "中" | "右"; 面: number; 联系方式: boolean };

export type AI回答 = {
  /** 公司：每一项是一种写法（双语名片中文名 / 英文名），一项里可以有几行（公司名分两行排），第一项是主的 */
  公司: number[][];
  /** 名片上的人：第一个是主联系人。名字可以有几种写法（李娜 / Lina Li） */
  联系人: { 名字: number[]; 职位: number[] }[];
  地址: number[];
  /** logo 字、标语、业务说明、二维码旁的字：不进任何格子，也不进备注 */
  标语: number[];
  /** 从给的行业选项里挑一个，挑不出就空 */
  行业: string;
  /** 中文译文：原文是中文或英文的留空 */
  译: { 公司: string; 名字: string; 职位: string; 地址: string };
};

const 联系方式re = /@|https?:|www\.|\.(com|net|org|cn|co|io)\b|\+?\d[\d\s()./-]{6,}\d/i;

/** 和拆字段同一个顺序（parse.ts 排好的行），行号两边对得上 */
export function 名片行们(框们: 框[]): 名片行[] {
  const 行们 = 排好的行(框们);
  const 最大 = Math.max(1, ...行们.map((b) => b.h));
  const 左 = Math.min(...行们.map((b) => b.cx - b.w / 2)), 右 = Math.max(...行们.map((b) => b.cx + b.w / 2));
  return 行们.map((b, i) => {
    const 位 = (b.cx - 左) / Math.max(1, 右 - 左);
    return { i, text: b.text.trim(), 字号: Math.round((b.h / 最大) * 10), 位: 位 < 0.4 ? "左" : 位 > 0.6 ? "右" : "中", 面: b.side, 联系方式: 联系方式re.test(b.text) };
  });
}

export const AI系统提示 = (行业们: readonly string[]) => `你是外贸 CRM 的名片整理助手。输入是 OCR 从一张名片照片上认出的文字行，每行开头是行号，后面是原文和「字号 / 位置」提示（字号 10 最大）。OCR 可能认错个别字。
只回 JSON，按行号指出每样东西在哪几行，**不要抄写或改写原文**：
{"公司":[[行号,…],…],"联系人":[{"名字":[行号,…],"职位":[行号,…]}],"地址":[行号,…],"标语":[行号,…],"行业":"","译":{"公司":"","名字":"","职位":"","地址":""}}
- 公司：每一项是公司的一种写法（双语名片的中文名、英文名各一项），公司名分两行排的放在同一项里；最主要的写法放第一项。只是 logo 字、缩写的不算公司。
- 联系人：名片上的每个人一项，主联系人放第一个；同一个人的几种写法（中文名、英文名）都放进他的「名字」；部门和职位都放进「职位」。没有人名就给空数组。
- 地址：地址那几行（含邮编、城市、国家）。
- 标语：logo 字、口号、标语、业务说明（比如「Seafood business」「Since 1952」）、二维码旁边的字。
- 标了「联系方式」的行（电话、邮箱、网址）不用管。
- 行业：从这些里选一个最贴的：${行业们.join("、")}；看不出就给空字符串。
- 译：主公司、主联系人名字、他的职位、地址的简体中文译文。原文是中文或英文的就留空字符串；人名用通行的中文音译。`;

export function AI用户消息(行们: 名片行[]): string {
  return 行们.map((l) => `${l.i}\t${l.text}\t[字号${l.字号}，${l.位}${l.面 ? "，背面" : ""}${l.联系方式 ? "，联系方式" : ""}]`).join("\n");
}

/** 把模型回的 JSON 收拾成 AI回答：行号要在范围里、不重复；不认识的行业丢掉。整个不像样就返回 null（用规则） */
export function 验AI回答(raw: unknown, 行数: number, 行业们: readonly string[]): AI回答 | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const 号 = (v: unknown): number[] =>
    Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 行数))] : [];
  const 字 = (v: unknown, 长 = 200) => (typeof v === "string" ? v.trim().slice(0, 长) : "");
  const 公司 = Array.isArray(o.公司) ? o.公司.map((x) => 号(Array.isArray(x) ? x : [x])).filter((x) => x.length) : [];
  const 联系人 = Array.isArray(o.联系人)
    ? o.联系人.map((p) => ({ 名字: 号((p as Record<string, unknown>)?.名字), 职位: 号((p as Record<string, unknown>)?.职位) })).filter((p) => p.名字.length)
    : [];
  if (!Array.isArray(o.公司) && !Array.isArray(o.联系人)) return null;
  const 译 = (o.译 && typeof o.译 === "object" ? o.译 : {}) as Record<string, unknown>;
  const 行业 = 字(o.行业, 40);
  return {
    公司: 公司.slice(0, 4), 联系人: 联系人.slice(0, 6), 地址: 号(o.地址), 标语: 号(o.标语),
    行业: 行业们.includes(行业) ? 行业 : "",
    译: { 公司: 字(译.公司), 名字: 字(译.名字, 60), 职位: 字(译.职位, 100), 地址: 字(译.地址, 300) },
  };
}

/** 合进规则拆好的字段之后多出来的：译文、行业、别的联系人（填表时进备注） */
export type AI附加 = { 行业: string; 译: AI回答["译"]; 别的联系人: string[] };

const 清 = (s: string) => s.replace(/\s+/g, " ").trim();
const 去头标签 = (s: string) => 清(s.replace(/^\s*(地址|Add(ress)?|Addr|公司|Company|职位|Title|姓名|Name)\s*[./:：]?\s*/i, ""));
const 汉 = /[㐀-鿿]/;
/** 一项里的几行拼起来：汉字直接连、别的用空格 */
const 拼 = (行们: 名片行[], 号们: number[]) => {
  const 字们 = 号们.map((i) => 行们[i]?.text ?? "").filter(Boolean).map(去头标签);
  return 清(字们.join(字们.every((t) => 汉.test(t)) ? "" : " "));
};

/**
 * 模型常把双语名片的中文名和英文名、或者旁边的 logo 字放进同一项（10-21 评测 56 张里 19 张）：
 *   - 一项里被另一行包含的行（logo 字「晨曦」、重复的一行）去掉
 *   - 一项里混了几种文字的按文字拆开，成几种写法；同一种文字的几行（公司名分两行排）还在一起
 */
export function 拆写法(行们: 名片行[], 项们: number[][]): number[][] {
  const 出: number[][] = [];
  for (const 项 of 项们) {
    const 字 = 项.map((i) => 清(行们[i]?.text ?? ""));
    const 留 = 项.filter((_, k) => 字[k] && !字.some((t, m) => m !== k && (t === 字[k] ? m < k : t.includes(字[k]))));
    const 组 = new Map<string, number[]>();
    for (const i of 留) { const k = 文字(行们[i].text); 组.set(k, [...(组.get(k) ?? []), i]); }
    出.push(...组.values());
  }
  return 出;
}

/**
 * AI 的回答合进规则的字段：公司 / 名字 / 职位 / 地址听 AI 的（值还是 OCR 原文），号码那些照旧听规则。
 * AI 说是标语的行从「剩下」里拿掉；AI 用了的行也不再出现在「剩下」。
 */
export function 合AI(规则: 字段, 框们: 框[], 答: AI回答): { 字段: 字段; 附加: AI附加 } {
  const 行们 = 名片行们(框们);
  const 用了 = new Set<number>([...答.公司.flat(), ...答.联系人.flatMap((p) => [...p.名字, ...p.职位]), ...答.地址, ...答.标语]);
  // 规则认成地址的行不算公司名（10-21 一张真名片：港口地址被并进了公司）
  const 地址行 = 答.地址.length ? null : 清(规则.address ?? "");
  const 公司项 = 答.公司.map((x) => x.filter((i) => !地址行 || 清(行们[i].text) !== 地址行));
  // 一项拆出来的几种写法：中文名在前，再是拉丁字母的，最后是别的文字（客户是中国人，泰阿文的公司名放第一格看不懂；那种有译文）。
  // 模型分开给的几项照它的先后（第二项常是 logo 字，不能挪到前面）
  const 先后 = (t: string) => (文字(t) === "汉" ? 0 : 文字(t) === "拉丁" ? 1 : 2);
  const 公司们 = [...new Set(公司项.flatMap((x) => 拆写法(行们, [x]).map((y) => 修后缀(拼(行们, y))).filter(Boolean).sort((a, b) => 先后(a) - 先后(b))))];
  const 主 = 答.联系人[0];
  const 名字们 = 主 ? [...new Set(主.名字.map((i) => 去头标签(行们[i].text)).filter(Boolean))] : [];
  // 职位也一样：「Sales Manager」「外贸部业务经理」是同一个职位的两种写法，取第一种
  const 职位们 = 主 ? 拆写法(行们, [主.职位]).map((x) => 拼(行们, x)).filter(Boolean) : [];
  const 职位 = 职位们[0] ?? "";
  const 地址 = 拼(行们, 答.地址);
  const 别的联系人 = 答.联系人.slice(1).map((p) => {
    const 名 = p.名字.map((i) => 去头标签(行们[i].text)).join(" / ");
    const 职 = 拼(行们, p.职位);
    return 职 ? `${名}（${职}）` : 名;
  }).filter(Boolean);
  const 用了的字 = new Set([...用了].map((i) => 清(行们[i].text)));
  const 韩 = /[가-힣]/;
  const 字段: 字段 = {
    ...规则,
    name: 名字们[0] ? (韩.test(名字们[0]) ? 名字们[0].replace(/\s+/g, "") : 名字们[0]) : 规则.name,
    nameAlt: 名字们.slice(1),
    company: 公司们[0] ?? 规则.company,
    companyAlt: 公司们.slice(1),
    title: 职位 || (主 ? null : 规则.title),
    titleAlt: 职位们.slice(1),
    address: 地址 || 规则.address,
    剩下: 规则.剩下.filter((t) => !用了的字.has(清(t))),
    name建议: 名字们[0] ? null : 规则.name建议,
  };
  // AI 说没有人（只有公司）：规则可能把公司名当人名了。规则认的人名不在 AI 说的公司 / 标语行里，才留着（10-21 一张韩文真名片上 AI 漏了人名）
  if (!答.联系人.length && 答.公司.length) {
    const 名 = 清(规则.name ?? "");
    const 公司行 = [...答.公司.flat(), ...答.标语].map((i) => 清(行们[i].text));
    if (!名 || 公司行.some((t) => t.includes(名) || 名.includes(t))) { 字段.name = null; 字段.nameAlt = []; }
    字段.title = 规则.title && !公司们.includes(规则.title) ? 规则.title : null;
  }
  return { 字段, 附加: { 行业: 答.行业, 译: 答.译, 别的联系人 } };
}
