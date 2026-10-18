/**
 * 真实性的总灯和「信息少，谨慎」横幅：全由代码按规则定，模型碰不到（方案 3.1 / 3.2）。
 *
 * 总灯：
 *   🔴 有一项硬红（制裁疑似命中、邮箱是仿冒官网的域名、工商库显示已注销、官网是停放页），
 *      或者域名注册不到 90 天、网上足迹又全是「未搜到」
 *   🟡 有标黄的项（对不上、免费邮箱、打不开……），或者能核的项里核到的不到一半；3 处以上标黄写「疑点较多」
 *   🟢 其它
 * 能核的项 = 已核 + 没查到 + 查不了；「没提供」「不适用」不算（没给电话不是对方的错）。
 */
import { 阶段表 } from "../types";
import type { 背调状态 } from "../state";
import { 核验项表, type 核验项, type 核验键, type 真实性, type 灯 } from "./types";
import { 主域名 } from "./domain";
import { IP库署名, 换了回复地址, type 邮件信号 } from "./mail";
import { 国名, 同一国 } from "./country";

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
  // 3 处以上对不上就不说「基本可信」了（10-18 bench：假公司 4 处黄还写着「基本可信」）
  if (黄 >= 3) return { 总灯: "yellow", 总字: `疑点较多，有 ${黄} 处要留意，先核实再谈` };
  if (黄) return { 总灯: "yellow", 总字: `基本可信，有 ${黄} 处要留意` };
  if (不到一半) return { 总灯: "yellow", 总字: "能核的不到一半，谨慎" };
  return { 总灯: "green", 总字: "核得上，没发现问题" };
}

/** 服务器那份 + 桌面端认的足迹 → 按固定顺序排好的整块；缺的项补上默认的那一行 */
export function 合成真实性(服务器项: 核验项[] | null, 足迹: 核验项, opts: { 名单更新于?: string; 邮件项?: 核验项; 人项?: 核验项 } = {}): 真实性 {
  const 有 = new Map<核验键, 核验项>();
  for (const x of 服务器项 ?? []) if (核验项表.some((k) => k.key === x.key) && x.key !== "footprint" && x.key !== "person") 有.set(x.key, x);
  有.set("footprint", 足迹);
  if (opts.人项) 有.set("person", opts.人项);
  const 默认: Record<核验键, 核验项> = {
    registry: { key: "registry", 灯: "gray", 态: "查不了", 事实: "服务器这次没核成，工商库没查" },
    vat: { key: "vat", 灯: "gray", 态: "没提供", 事实: "没提供税号，未查" },
    domain: { key: "domain", 灯: "gray", 态: "查不了", 事实: "服务器这次没核成，域名没查" },
    site: { key: "site", 灯: "gray", 态: "查不了", 事实: "服务器这次没核成，官网没查" },
    email: { key: "email", 灯: "gray", 态: "没提供", 事实: "没提供对方邮箱，未查" },
    phone: { key: "phone", 灯: "gray", 态: "没提供", 事实: "没提供对方电话，未查" },
    ip: opts.邮件项 ?? { key: "ip", 灯: "gray", 态: "没提供", 事实: "没贴询盘邮件原文，未查（背调模式里点「粘贴询盘邮件」可以带上）" },
    sanctions: { key: "sanctions", 灯: "gray", 态: "查不了", 事实: "服务器这次没核成，制裁名单没查" },
    footprint: 足迹,
    person: { key: "person", 灯: "gray", 态: "不适用", 事实: "" },
  };
  // 「人和号码」只在从人名 + 电话认出公司的那种背调里有，别的背调不列这一行
  const 项 = 核验项表.filter(({ key }) => key !== "person" || 有.has("person")).map(({ key }) => 有.get(key) ?? 默认[key]);
  return { 项, ...定总灯(项), ...(opts.名单更新于 ? { 名单更新于: opts.名单更新于 } : {}) };
}

const 结论字: Record<string, string> = { pass: "通过", fail: "不通过", softfail: "软失败", neutral: "中立", none: "没设", temperror: "临时出错", permerror: "配置错", policy: "按策略放行" };

/**
 * 「邮件头」那一项（第二期）：发件 IP 在哪国、SPF / DKIM / DMARC、回复地址换没换。灯：
 *   🟡 IP 国家和对方自称 / 登记的国家对不上；SPF、DKIM、DMARC 有不通过的；回复地址被换成了别的域名
 *   🟢 IP 国家对得上（或者没有能比的国家），认证都通过、回复地址没换
 *   ⚪ 看不到对方 IP（谷歌、微软等邮件服务发的）又没有别的可说；IP 库下不来
 * 不出红：这几样对不上的正常情况很多（出差、VPN、用海外服务器），只提醒问一句
 *
 * ip国家：查到的两位码；null = 库里没有；"查不了" = IP 库没下下来；undefined = 没有 IP 可查
 */
export function 邮件头项(信: 邮件信号, ip国家: string | null | "查不了" | undefined, 对照: { 国家?: string; 自报国家?: string } = {}): 核验项 {
  const 句: string[] = [];
  let 黄 = false;
  let ip态: 核验项["态"] = "没查到";
  const 链接 = [];
  const 比 = 对照.自报国家 ?? 对照.国家;
  const 比谁 = 对照.自报国家 ? "对方自称的国家" : "登记的国家";
  if (信.发件IP) {
    const 从 = 信.IP来源 === "X-Originating-IP" ? "邮件头里的原始发件 IP" : "最早一跳";
    if (ip国家 === "查不了") {
      ip态 = "查不了";
      句.push(`发件 IP ${信.发件IP}（${从}），IP 库这会儿没下下来，没判国家`);
    } else if (!ip国家) {
      句.push(`发件 IP ${信.发件IP}（${从}），IP 库里没有它在哪国`);
    } else {
      ip态 = "已核";
      链接.push(IP库署名);
      if (比 && !同一国(ip国家, 比)) {
        黄 = true;
        句.push(`发件 IP ${信.发件IP}（${从}）在${国名(ip国家)}，和${比谁}${国名(比)}对不上（出差、VPN、海外服务器都可能，问一句）`);
      } else 句.push(`发件 IP ${信.发件IP}（${从}）在${国名(ip国家)}${比 ? `，和${比谁}对得上` : ""}`);
    }
  } else if (信.经手) {
    ip态 = "不适用";
    句.push(`这封信经${信.经手}发出，邮件头里只有它们服务器的 IP，看不到对方自己的（Gmail、Outlook 网页版和用这些服务的企业邮箱都这样，不扣分）`);
  } else 句.push("邮件头里没认出发件 IP（可能只粘了正文，或者邮件头被删过）");
  const 认 = (["spf", "dkim", "dmarc"] as const).filter((k) => 信[k]);
  if (认.length) {
    const 坏 = 认.filter((k) => 信[k] === "fail" || (k === "spf" && 信[k] === "softfail"));
    if (坏.length) {
      黄 = true;
      句.push(`${坏.map((k) => k.toUpperCase()).join("、")} 不通过：发件域名可能被冒用，回信前核一下对方邮箱`);
    } else 句.push(认.map((k) => `${k.toUpperCase()} ${结论字[信[k]!] ?? 信[k]}`).join("、"));
  }
  if (换了回复地址(信)) {
    黄 = true;
    句.push(`回复地址被换成了 ${信.回复到}（发件人是 ${信.发件人}），点「回复」会发到别处，回信前确认一下`);
  }
  const 灯: 核验项["灯"] = 黄 ? "yellow" : ip态 === "已核" || (认.length && ip态 !== "查不了") ? "green" : "gray";
  // 灰灯就照 IP 那一半的实情写（查不了 / 不适用 / 没查到），别因为有认证结论就写成「已核」
  return { key: "ip", 灯, 态: 灯 === "gray" ? ip态 : "已核", 事实: 句.join("；"), ...(链接.length ? { 链接 } : {}) };
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
  if (取("footprint")?.态 === "没查到") 缺.push("没搜到 Facebook 主页");
  if (!s.fields.site) 缺.push("没找到官网");
  else if (项.length && 取("domain")?.态 !== "已核") 缺.push("域名注册日期查不到");
  if (!s.fields.founded) 缺.push("成立年份查不到");
  if (!s.fields.size) 缺.push("规模查不到");
  if (源 < 3) 缺.push(源 ? `独立来源只有 ${源} 个` : "没有独立来源");
  const 文字 = `网上能查到的很少${缺.length ? `：${缺.join("、")}` : ""}。建议先要营业执照、视频验厂，或走信用证 / 小额试单。`;
  return { 缺, 文字 };
}
