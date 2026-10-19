/**
 * 10-18 对比免费产品（汇总.md §5 / §7）加的几块：风险必查四项、在卖型号、联系人、型号对比、英文开发信。
 * 模型给的东西在这里过一遍才进报告，规矩和别的结论一样——**不带核得上的来源就不收**，而且更严一档：
 *   型号名、联系人的姓名 / 电话 / 邮箱必须在那条来源的原文里出现过（模型最爱编的就是这几样）；
 *   联系人只收公司公开页面上的业务联系人，私人社交页（person.ts 是私人社交）不收；
 *   必查四项查不到就写「查不到」、不带来源，不许拿没来源的话充数。
 * 纯函数：run.ts 把「来源 → 材料原文」的查法传进来（找），测试直接喂假材料。
 */
import { 必查表, type 必查项, type 在卖型号, type 联系人, type 型号对比, type 关键发现, type 产品匹配 } from "./types";
import type { 同行判断 } from "./score";
import { 全句 } from "./retry";
import { 是私人社交 } from "./person";

/** 模型写的来源 → 材料里那一条的网址和原文（同一个网址搜到过、又读过的，原文拼在一起） */
export type 找材料 = (u: unknown) => { url: string; text: string } | undefined;

const 规 = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_‐–—/.,:;'"’()（）]+/g, "");

/** 词在原文里出现过（忽略大小写、空格、连字符：「HB-150」「HB 150」「hb150」算同一个） */
export function 原文里有(原文: string, 词: string): boolean {
  const w = 规(词);
  return w.length >= 2 && 规(原文).includes(w);
}

/** 电话在原文里出现过：原文里每一串像电话的数字比位数，一样或者一头是另一头的结尾（国家码写没写都认），至少 7 位 */
export function 号码在原文(原文: string, 号: string): boolean {
  const 要 = 号.replace(/\D/g, "").replace(/^00/, "");
  if (要.length < 7) return false;
  for (const m of 原文.matchAll(/\+?\d[\d\s().-]{5,22}\d/g)) {
    const 有 = m[0].replace(/\D/g, "").replace(/^00/, "");
    if (有.length < 7) continue;
    const 去零 = (x: string) => x.replace(/^0+/, "");
    if (有 === 要 || (有.length >= 8 && 要.endsWith(去零(有))) || (要.length >= 8 && 有.endsWith(去零(要)))) return true;
  }
  return false;
}

const 级们 = ["none", "low", "mid", "high"] as const;
const 是级 = (v: unknown): v is 必查项["级别"] => (级们 as readonly unknown[]).includes(v);
const 同行们 = ["是", "部分", "否", "查不到"] as const;
const 是同行判断 = (v: unknown): v is 同行判断 => (同行们 as readonly unknown[]).includes(v);
const 对象 = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const 列 = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(对象) : []);

/**
 * 必查四项：固定四行、固定顺序，模型漏了哪项就是「查不到」。
 * 有结论但来源核不上 → 也当查不到（不带来源）；同行那一项的「是」只在有来源时才信，没来源一律「查不到」（不封顶）
 */
export function 认必查(raw: unknown, 找: 找材料): 必查项[] {
  const o = 对象(raw);
  return 必查表.map(({ key }) => {
    const x = 对象(o[key]);
    const 页 = 找(x.来源 ?? x.source);
    const 结论 = 全句(x.结论, 200);
    const 查不到: 必查项 = { key, 结论: "查不到（材料里没有）", 级别: "none", ...(key === "同行" ? { 是: "查不到" as const } : {}) };
    if (!结论 || !页 || /^(查不到|没查到|未查到|材料里没有|不详|未知)/.test(结论)) return 查不到;
    const 是 = key === "同行" ? (是同行判断(x.是) ? x.是 : "查不到") : undefined;
    const 级别 = 是级(x.级别) ? x.级别 : "none";
    const 应对 = 级别 !== "none" ? 全句(x.应对, 120) : "";
    return { key, 结论, 级别, source: 页.url, ...(是 ? { 是 } : {}), ...(应对 ? { 应对 } : {}) };
  });
}

/** 在卖的具体型号：最多 3 个，型号名必须在来源原文里出现过 */
export function 认型号(raw: unknown, 找: 找材料): 在卖型号[] {
  const 出: 在卖型号[] = [];
  for (const x of 列(raw)) {
    const 型号 = typeof x.型号 === "string" ? x.型号.trim().slice(0, 60) : "";
    const 页 = 找(x.来源 ?? x.source);
    if (!型号 || !页 || !原文里有(页.text, 型号) || 出.some((y) => 规(y.型号) === 规(型号))) continue;
    const 是什么 = 全句(x.是什么, 80);
    出.push({ 型号, ...(是什么 ? { 是什么 } : {}), source: 页.url });
    if (出.length >= 3) break;
  }
  return 出;
}

/**
 * 公开的业务联系人：最多 3 位。姓名、邮箱、电话各自核：在来源原文里出现过才留，没出现的那一格去掉；
 * 三格都没留下的整条不要（光一个「采购经理」岗位没法联系）。私人社交页上的不收
 */
export function 认联系人(raw: unknown, 找: 找材料): 联系人[] {
  const 出: 联系人[] = [];
  for (const x of 列(raw)) {
    const 页 = 找(x.来源 ?? x.source);
    if (!页 || 是私人社交(页.url)) continue;
    const 姓名 = typeof x.姓名 === "string" && 原文里有(页.text, x.姓名) ? x.姓名.trim().slice(0, 60) : undefined;
    const 邮箱 = typeof x.邮箱 === "string" && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(x.邮箱.trim()) && 页.text.toLowerCase().includes(x.邮箱.trim().toLowerCase()) ? x.邮箱.trim() : undefined;
    const 电话 = typeof x.电话 === "string" && 号码在原文(页.text, x.电话) ? x.电话.trim().slice(0, 30) : undefined;
    if (!姓名 && !邮箱 && !电话) continue;
    const 岗位 = 全句(x.岗位, 40);
    const 条: 联系人 = { ...(岗位 ? { 岗位 } : {}), ...(姓名 ? { 姓名 } : {}), ...(电话 ? { 电话 } : {}), ...(邮箱 ? { 邮箱 } : {}), source: 页.url };
    if (出.some((y) => (y.姓名 && y.姓名 === 条.姓名) || (y.邮箱 && y.邮箱 === 条.邮箱) || (y.电话 && y.电话 === 条.电话))) continue;
    出.push(条);
    if (出.length >= 3) break;
  }
  return 出;
}

/** 型号对比：对方那一格必须是认出来的在卖型号之一（没有型号就没有对比） */
export function 认型号对比(raw: unknown, 型号们: 在卖型号[]): 型号对比[] {
  const 出: 型号对比[] = [];
  for (const x of 列(raw)) {
    const 对方原 = typeof x.对方 === "string" ? x.对方 : "";
    const 对上 = 型号们.find((m) => 规(对方原).includes(规(m.型号)));
    const 我们 = 全句(x.我们, 80);
    const 怎么比 = 全句(x.怎么比, 240);
    if (!对上 || !我们 || !怎么比 || 出.some((y) => y.对方 === 对上.型号)) continue;
    出.push({ 对方: 对上.型号, 我们, 怎么比 });
    if (出.length >= 3) break;
  }
  return 出;
}

/** 英文开发信：主题一行；正文要英文（汉字不超过 3 个）、60–320 词（要的是 120–200，留余量），不合格就不给 */
export function 认开发信(raw: unknown): { 主题: string; 正文: string } | undefined {
  const o = 对象(raw);
  const 主题 = typeof o.主题 === "string" ? o.主题.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  const 正文 = typeof o.正文 === "string" ? o.正文.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "";
  if (!主题 || !正文) return undefined;
  const 汉字 = (正文.match(/[㐀-鿿]/g) ?? []).length + (主题.match(/[㐀-鿿]/g) ?? []).length;
  const 词 = 正文.split(/\s+/).filter(Boolean).length;
  if (汉字 > 3 || 词 < 60 || 词 > 320) return undefined;
  return { 主题, 正文 };
}

/**
 * 母公司定向搜索（10-18 复核：Ansell Lighting 的母公司 Endo 有自己的工厂，我们让模型自己挑词搜，写了「查不到」，
 * 免费产品都查到了）。风险那一步由程序先发这一次，不交给模型挑词
 */
export function 母公司查询(名: string): string {
  return `"${名.trim()}" ("owned by" OR "parent company" OR "acquired by" OR "subsidiary of")`;
}

/** 必查里有级别的那几项也算风险（进风险级别、进「先核实」结论）；和模型另列的风险重了就不重复 */
export function 必查转风险(项: 必查项[]): { 级别: "low" | "mid" | "high"; 说明: string; 来源?: string }[] {
  return 项.filter((x) => x.级别 !== "none" && x.source).map((x) => ({ 级别: x.级别 as "low" | "mid" | "high", 说明: `${必查表.find((k) => k.key === x.key)!.label}：${x.结论}`, 来源: x.source }));
}

/* ---------- 10-18 报告结构（盲评 A + D：只学 D 的结构，事实照我们的规矩核） ---------- */

/** 它是哪类客户 + 开发前最要先弄清的 1–2 件事。类型没写就整块不要 */
export function 认画像(raw: unknown): { 类型: string; 先验证: string[] } | undefined {
  const o = 对象(raw);
  const 类型 = 全句(o.类型, 80);
  if (!类型) return undefined;
  const 先验证 = (Array.isArray(o.先验证) ? o.先验证 : []).map((x) => 全句(x, 100)).filter(Boolean).slice(0, 2);
  return { 类型, 先验证 };
}

/** 关键发现：最多 3 条，每条一句事实、必须带核得上的来源，机会 / 障碍至少写一样 */
export function 认发现(raw: unknown, 找: 找材料): 关键发现[] {
  const 出: 关键发现[] = [];
  for (const x of 列(raw)) {
    const 页 = 找(x.来源 ?? x.source);
    const 事实 = 全句(x.事实, 200);
    const 机会 = 全句(x.机会, 120);
    const 障碍 = 全句(x.障碍, 120);
    if (!页 || !事实 || (!机会 && !障碍) || 出.some((y) => y.事实 === 事实)) continue;
    出.push({ 事实, ...(机会 ? { 机会 } : {}), ...(障碍 ? { 障碍 } : {}), source: 页.url });
    if (出.length >= 3) break;
  }
  return 出;
}

const 匹配档 = { 高: "高", 中: "中", 低: "低", high: "高", mid: "中", low: "低" } as const;
const 开发档 = { 优先: "优先", 选择性: "选择性", 谨慎: "谨慎" } as const;

/**
 * 产品匹配：按我们的品类最多 3 行。必须带核得上的来源；它的系列名要在那条来源原文里出现过，没出现的去掉
 * （和在卖型号同一条规矩：模型最爱编的就是型号名）。匹配度、开发优先级写错的整行不要
 */
export function 认匹配(raw: unknown, 找: 找材料): 产品匹配[] {
  const 出: 产品匹配[] = [];
  for (const x of 列(raw)) {
    const 品类 = 全句(x.品类, 30);
    const 匹配 = 匹配档[String(x.匹配 ?? "").trim() as keyof typeof 匹配档];
    const 开发 = 开发档[String(x.开发 ?? "").trim().replace(/开发$/, "") as keyof typeof 开发档];
    const 页 = 找(x.来源 ?? x.source);
    if (!品类 || !匹配 || !开发 || !页 || 出.some((y) => y.品类 === 品类)) continue;
    const 系列 = [...new Set((Array.isArray(x.系列) ? x.系列 : []).filter((v): v is string => typeof v === "string").map((v) => v.trim().slice(0, 40)))]
      .filter((v) => 原文里有(页.text, v))
      .slice(0, 4);
    const 依据 = 全句(x.依据, 160);
    const 准备 = 全句(x.准备, 160);
    出.push({ 品类, 匹配, 开发, 系列, ...(依据 ? { 依据 } : {}), ...(准备 ? { 准备 } : {}), source: 页.url });
    if (出.length >= 3) break;
  }
  return 出;
}

/** 业务简介里写到的认证（CE / ENEC / RoHS / UKCA / UL……），原样大小写去重 */
export function 我们的认证(简介: string | undefined): string[] {
  const 出: string[] = [];
  for (const m of (简介 ?? "").matchAll(/(?<![A-Za-z])(CE|ENEC\+?|RoHS|UKCA|UL|ETL|DLC|CB|SAA|SASO|TÜV|TUV|GS|FCC|ErP|ERP|REACH|CCC|KC|PSE|BIS|INMETRO|IECEx|ATEX)(?![A-Za-z])/g)) {
    const v = m[1] === "ROHS" ? "RoHS" : m[1];
    if (!出.some((x) => x.toLowerCase() === v.toLowerCase())) 出.push(v);
  }
  return 出;
}

const 英国 = /英国|英格兰|苏格兰|威尔士|北爱|\bUK\b|United Kingdom|Great Britain|England|Scotland|Wales|Northern Ireland/i;
const 中东 = /中东|海湾|沙特|阿联酋|迪拜|阿布扎比|卡塔尔|科威特|阿曼|巴林|Middle East|GCC|Saudi|UAE|Emirates|Dubai|Qatar|Kuwait|Oman|Bahrain/i;

/**
 * 认证提醒（D 那份的「你们的认证可能还不够」）：代码按业务简介里的认证、对方国家、我们的目标市场拼，不经模型、不花钱。
 * 只说「要核对什么」，不替用户下「够不够」的结论（我们不知道每款产品的证书范围）
 */
export function 认证提醒(简介: string | undefined, 对方国家: string | undefined): string[] {
  const 证 = 我们的认证(简介);
  const 出 = [
    证.length
      ? `我们的 ${证.join(" / ")} 不一定覆盖每一款产品：报价前按具体型号核对证书范围，测试报告一并准备好。`
      : "业务简介里没写认证：报价前按具体型号核对对方要的认证和测试报告。",
  ];
  const 地 = `${对方国家 ?? ""} ${简介 ?? ""}`;
  if (英国.test(对方国家 ?? "")) 出.push("英国市场：问清对方要 CE 还是 UKCA，以及有没有英国本地的标准或交付要求。");
  if (中东.test(地)) 出.push("中东项目：可能要当地认证（比如沙特 SASO），还要确认电压、高温、防尘防水等级这些当地条件。");
  return 出;
}
