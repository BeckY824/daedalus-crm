/**
 * 官网通不通、是不是停放页。复用读网页那一套（read-page.ts，防 SSRF），不经模型、不另花钱。
 *
 * 打不开只标黄：不少欧洲网站拦海外 IP。停放页（「这个域名在卖」）、建站模板默认页才标红——
 * 一家正经做生意的公司，官网不会是一张「Welcome to nginx」。
 */
import { 读网页 } from "../read-page";
import { 主域名 } from "./domain";
import { 提到了 } from "./names";
import type { 核验项, 官网说法 } from "./types";

const 停放词 = [
  /this domain (name )?(is|may be) for sale/i,
  /buy this domain/i,
  /domain (is )?parked/i,
  /parked (free|domain)/i,
  /the domain .{0,40} is for sale/i,
  /domain names? for sale/i,
  /hugedomains/i,
  /\bsedo(parking)?\b/i,
  /afternic/i,
  /\bdan\.com\b/i,
  /godaddy.{0,40}(parked|coming soon)/i,
  /domain has (just )?been registered/i,
  /域名(正在)?(出售|转让)/,
];
const 模板词 = [/welcome to nginx/i, /apache2? .{0,20}default page/i, /^it works!?$/im, /index of \//i, /just another wordpress site/i, /iis windows server/i, /plesk.{0,40}default/i, /cpanel.{0,40}(default|coming soon)/i];
const 停放站 = /(^|\.)(sedo\.com|dan\.com|afternic\.com|hugedomains\.com|godaddy\.com|undeveloped\.com|bodis\.com|parkingcrew\.net|above\.com|namecheap\.com)$/i;

/** 只看首页文字的判断，导出给测试 */
export function 认停放页(title: string, text: string, 落地: string): string | null {
  let h = "";
  try {
    h = new URL(落地).hostname;
  } catch {
    /* 落地网址坏了：只看文字 */
  }
  if (停放站.test(h)) return `打开跳到了域名交易站 ${h}`;
  const 全 = `${title}\n${text.slice(0, 3000)}`;
  // 停放页都很短；长页面里提一句「domain for sale」的（比如做域名生意的公司）不算
  if (text.length < 3000 && 停放词.some((r) => r.test(全))) return "官网是域名停放页（「这个域名在卖」）";
  // 模板默认页：字数很少、又命中模板词才算（正经网站页脚偶尔也写 WordPress）
  if (text.length < 600 && 模板词.some((r) => r.test(全))) return "官网是建站模板的默认页，没有内容";
  return null;
}

/**
 * 官网首页自己说的成立年份 / 从业年数（10-18 对比免费产品：豆包抓到 Sunrgy 官网写「10+ 年经验」，工商登记 2020 年才成立）。
 * 只认几种明确的写法（英、德、法、西、意、荷、中），认不出就当没说。和工商登记比在 check.ts 的 比官网说法
 */
export function 认官网说法(text: string): 官网说法 | undefined {
  const t = text.slice(0, 20000).replace(/\s+/g, " ");
  const 今年 = new Date().getFullYear();
  const 成 = t.match(/\b(?:since|established(?: in)?|est\.|founded(?: in)?|seit|gegr(?:ü|ue)ndet(?: im jahr| in)?|depuis|fond[ée]e? en|desde|fundad[ao] en|dal|fondata nel|sinds|opgericht in)\s*((?:19|20)\d{2})\b|(?:成立于|创立于|始于)\s*((?:19|20)\d{2})/i);
  const 经 = t.match(/(?:\bover |\bmore than |\b)(\d{1,3})\s*\+?\s*(?:years?|yrs?|jahre[n]?|ans|años|anni|jaar)(?: of)?\s+(?:experience|expertise|erfahrung|d['’]exp[ée]rience|de experiencia|di esperienza|ervaring|in (?:the )?(?:business|industry|lighting|market))|(\d{1,3})\s*\+?\s*年(?:以上)?(?:的)?(?:行业|从业)?经验/i);
  const 成立年 = 成 ? Number(成[1] ?? 成[2]) : undefined;
  const 经验年 = 经 ? Number(经[1] ?? 经[2]) : undefined;
  const 好成 = 成立年 && 成立年 >= 1850 && 成立年 <= 今年 ? 成立年 : undefined;
  const 好经 = 经验年 && 经验年 >= 2 && 经验年 <= 150 ? 经验年 : undefined;
  if (!好成 && !好经) return undefined;
  const 原文 = [好成 ? 成![0] : "", 好经 ? 经![0] : ""].filter(Boolean).join("；").trim();
  return { ...(好成 ? { 成立年: 好成 } : {}), ...(好经 ? { 经验年: 好经 } : {}), 原文 };
}

/** 放行代理假IP：只给本机实验（开着「假 IP」代理的电脑，见 read-page.ts 是代理假IP），服务器上从不传 */
export async function 查官网(域: string, 公司: string, signal?: AbortSignal, 读选项: { 放行代理假IP?: boolean } = {}): Promise<核验项> {
  let 页: Awaited<ReturnType<typeof 读网页>> | null = null;
  let 错 = "";
  for (const 协议 of ["https", "http"]) {
    try {
      页 = await 读网页(`${协议}://${域}/`, { signal, 放行代理假IP: 读选项.放行代理假IP });
      break;
    } catch (e) {
      错 = e instanceof Error ? e.message.replace(/^这个网址读不了：/, "") : "打不开";
    }
  }
  if (!页) return { key: "site", 灯: "yellow", 态: "查不了", 事实: `${域} 打不开（${错}）。有的网站拦海外访问，不一定是假的` };
  const 停放 = 认停放页(页.title, 页.text, 页.url);
  const 链接 = [{ title: 页.title || 域, url: 页.url }];
  if (停放) return { key: "site", 灯: "red", 态: "已核", 事实: 停放, 硬红: 停放, 链接 };
  const https = 页.url.startsWith("https://");
  const 落地主 = 主域名(页.url);
  const 跳走 = 落地主 && 落地主 !== 主域名(域) ? `，打开后跳到 ${落地主}` : "";
  const 有名 = 提到了(`${页.title}\n${页.text.slice(0, 6000)}`, 公司);
  // 首页上找不到这家的名字：多半不是它的官网（10-18 bench：假公司 Lumexa Trading 被认到了同名前缀的 Lumexa Imaging），标黄
  const 事实 = `可打开，${https ? "HTTPS" : "只有 HTTP（没加密）"}${跳走}；${有名 ? "页面上有这家公司的名字" : "首页上没看到这家公司的名字，可能不是这家的官网"}`;
  const 说法 = 认官网说法(`${页.title}\n${页.text}`);
  return { key: "site", 灯: https && 有名 ? "green" : "yellow", 态: "已核", 事实, 链接, ...(说法 ? { 说法 } : {}) };
}
