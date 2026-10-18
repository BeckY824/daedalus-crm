/**
 * 真实性的总灯和「信息少，谨慎」横幅：全由代码按规则定，模型碰不到（方案 3.1 / 3.2）。
 *
 * 总灯：
 *   🔴 有一项硬红（制裁疑似命中、邮箱是仿冒官网的域名、工商库显示已注销、官网是停放页），
 *      或者域名注册不到 90 天、网上足迹又全是「未搜到」
 *   🟡 有标黄的项（对不上、免费邮箱、打不开……），或者能核的项里核到的不到一半
 *   🟢 其它
 * 能核的项 = 已核 + 没查到 + 查不了；「没提供」「不适用」不算（没给电话不是对方的错）。
 */
import { 阶段表 } from "../types";
import type { 背调状态 } from "../state";
import { 核验项表, type 核验项, type 核验键, type 真实性, type 灯 } from "./types";
import { 主域名 } from "./domain";

export const 灯符: Record<灯, string> = { green: "🟢", yellow: "🟡", red: "🔴", gray: "⚪" };

export function 能核(项: 核验项[]): { 能: number; 核到: number } {
  const 能 = 项.filter((x) => x.态 === "已核" || x.态 === "没查到" || x.态 === "查不了");
  return { 能: 能.length, 核到: 能.filter((x) => x.态 === "已核").length };
}

export function 定总灯(项: 核验项[]): { 总灯: 灯; 总字: string } {
  const 硬 = 项.find((x) => x.硬红);
  if (硬) return { 总灯: "red", 总字: `有明显问题：${硬.硬红}` };
  const 新 = 项.find((x) => x.key === "domain" && x.新域名);
  const 足迹 = 项.find((x) => x.key === "footprint");
  if (新 && 足迹?.态 === "没查到") return { 总灯: "red", 总字: "有明显问题：域名注册不到 90 天，网上又搜不到这家公司的任何足迹" };
  const 黄 = 项.filter((x) => x.灯 === "yellow").length;
  const { 能, 核到 } = 能核(项);
  const 不到一半 = 能 === 0 || 核到 / 能 < 0.5;
  if (黄 && 不到一半) return { 总灯: "yellow", 总字: `能核的不到一半，有 ${黄} 处要留意` };
  if (黄) return { 总灯: "yellow", 总字: `基本可信，有 ${黄} 处要留意` };
  if (不到一半) return { 总灯: "yellow", 总字: "能核的不到一半，谨慎" };
  return { 总灯: "green", 总字: "核得上，没发现问题" };
}

/** 服务器那份 + 桌面端认的足迹 → 按固定顺序排好的整块；缺的项补上默认的那一行 */
export function 合成真实性(服务器项: 核验项[] | null, 足迹: 核验项, opts: { 名单更新于?: string; 有邮件?: boolean } = {}): 真实性 {
  const 有 = new Map<核验键, 核验项>();
  for (const x of 服务器项 ?? []) if (核验项表.some((k) => k.key === x.key) && x.key !== "footprint") 有.set(x.key, x);
  有.set("footprint", 足迹);
  const 默认: Record<核验键, 核验项> = {
    registry: { key: "registry", 灯: "gray", 态: "查不了", 事实: "服务器这次没核成，工商库没查" },
    vat: { key: "vat", 灯: "gray", 态: "没提供", 事实: "没提供税号，未查" },
    domain: { key: "domain", 灯: "gray", 态: "查不了", 事实: "服务器这次没核成，域名没查" },
    site: { key: "site", 灯: "gray", 态: "查不了", 事实: "服务器这次没核成，官网没查" },
    email: { key: "email", 灯: "gray", 态: "没提供", 事实: "没提供对方邮箱，未查" },
    phone: { key: "phone", 灯: "gray", 态: "没提供", 事实: "没提供对方电话，未查" },
    ip: { key: "ip", 灯: "gray", 态: "没提供", 事实: opts.有邮件 ? "邮件头里没认出发件 IP" : "没贴询盘邮件原文，未查" },
    sanctions: { key: "sanctions", 灯: "gray", 态: "查不了", 事实: "服务器这次没核成，制裁名单没查" },
    footprint: 足迹,
  };
  const 项 = 核验项表.map(({ key }) => 有.get(key) ?? 默认[key]);
  return { 项, ...定总灯(项), ...(opts.名单更新于 ? { 名单更新于: opts.名单更新于 } : {}) };
}

/** 状态里认得出的「查不到」的步数：没认出官网、基本面一格没填、相关性信息不足、没有近期信号、出错的步 */
export function 查不到步数(s: 背调状态): number {
  let n = 0;
  if (!s.fields.site || s.stages.identify.status === "error") n++;
  if (!(["founded", "size", "business", "buyerType", "contact"] as const).some((k) => s.fields[k]) || s.stages.basics.status === "error") n++;
  if (!s.评分 || s.评分.信息不足) n++;
  if (!s.tags.some((t) => t.tone === "signal") || s.stages.signals.status === "error") n++;
  for (const st of 阶段表) if (!["identify", "basics", "signals", "fit", "approach"].includes(st.id) && s.stages[st.id].status === "error") n++;
  return n;
}

/** 来源里有几个独立的网站（按主域名算，不算它自己的官网） */
export function 独立来源数(s: 背调状态): number {
  const 官网 = s.fields.site?.value ? 主域名(s.fields.site.value) : undefined;
  const 域 = new Set<string>();
  for (const x of s.sources) {
    const d = 主域名(x.url);
    if (d && d !== 官网) 域.add(d);
  }
  return 域.size;
}

export type 信息少提示 = { 缺: string[]; 文字: string };

/**
 * 「信息少，谨慎」横幅（方案 3.2）：任一条成立就出——
 *   真实性能核的项里核到的不到一半；6 步里 3 步以上查不到；全部来源不到 3 个独立网站（不算它自己的官网）。
 * 缺哪几样就列哪几样，代码拼，不交给模型写。还没跑完（没有 done）不出
 */
export function 信息少(s: 背调状态): 信息少提示 | null {
  if (!s.done) return null;
  const 项 = s.真实性?.项 ?? [];
  const { 能, 核到 } = 能核(项);
  const 核得少 = 项.length > 0 && (能 === 0 || 核到 / 能 < 0.5);
  const 步 = 查不到步数(s);
  const 源 = 独立来源数(s);
  if (!核得少 && 步 < 3 && 源 >= 3) return null;
  const 取 = (k: 核验键) => 项.find((x) => x.key === k);
  const 缺: string[] = [];
  if (项.length && 取("registry")?.态 !== "已核") 缺.push("没有工商登记");
  if (取("footprint")?.态 === "没查到") 缺.push("没有 LinkedIn / Facebook");
  if (!s.fields.site) 缺.push("没找到官网");
  else if (项.length && 取("domain")?.态 !== "已核") 缺.push("域名注册日期查不到");
  if (!s.fields.founded) 缺.push("成立年份查不到");
  if (!s.fields.size) 缺.push("规模查不到");
  if (源 < 3) 缺.push(源 ? `独立来源只有 ${源} 个` : "没有独立来源");
  const 文字 = `网上能查到的很少${缺.length ? `：${缺.join("、")}` : ""}。建议先要营业执照、视频验厂，或走信用证 / 小额试单。`;
  return { 缺, 文字 };
}
