/**
 * 服务器这一头的程序直查：一次请求，几项并行，每项各自兜底（一项挂了只是那一项「查不了」）。
 * /api/gateway/v1/research/verify 调它。全程不经模型，每一行事实都来自某个接口的原样返回。
 */
import { 查域名年龄, 天数, type 域名年龄 } from "./rdap";
import { 查官网 } from "./site";
import { 查邮箱, 查电话, 默认查MX, type 查MX } from "./contact";
import { 取名单, 制裁项, type 名单 } from "./sanctions";
import { 查工商, 查税号 } from "./registry";
import { 主域名 } from "./domain";
import { 查英国进口 } from "./imports";
import { 查不了 } from "./net";
import type { 核验回应, 核验请求, 核验项, 核验键 } from "./types";

export type 核验依赖 = {
  查年龄?: (域: string) => Promise<域名年龄>;
  查官网?: typeof 查官网;
  查MX?: 查MX;
  取名单?: () => Promise<名单[]>;
  查工商?: typeof 查工商;
  查税号?: typeof 查税号;
  查进口?: typeof 查英国进口;
  signal?: AbortSignal;
  /** 只给本机实验：开着「假 IP」代理时读官网要放行（read-page.ts 是代理假IP）。服务器上从不传 */
  放行代理假IP?: boolean;
};

/**
 * 官网自己的说法和工商登记比（10-18 对比免费产品第七点）。只在登记的成立日期确定、公司不到 10 年时比：
 *   官网写「since 2009」，登记 2020 年成立（早了 2 年以上）→ 官网那一项标黄、补一句
 *   官网写「10+ years experience」，登记成立才 5 年（多出 2 年以上）→ 同上
 * 老公司改过名、换过主体的很常见（登记的是新主体），所以只比年轻公司、只标黄、写明「可能是前身」
 */
export function 比官网说法(site: 核验项, registry: 核验项, 今年 = new Date().getFullYear()): 核验项 {
  const 登记年 = registry.态 === "已核" && registry.成立 ? Number(registry.成立.slice(0, 4)) : NaN;
  const 说 = site.说法;
  if (!说 || !Number.isFinite(登记年) || 今年 - 登记年 >= 10) return site;
  const 岁 = 今年 - 登记年;
  const 不对: string[] = [];
  if (说.成立年 && 说.成立年 <= 登记年 - 2) 不对.push(`官网写 ${说.成立年} 年起`);
  if (说.经验年 && 说.经验年 >= 岁 + 2) 不对.push(`官网写 ${说.经验年} 年以上经验`);
  if (!不对.length) return site;
  return { ...site, 灯: "yellow", 事实: `${site.事实}；${不对.join("、")}（「${说.原文}」），工商登记 ${登记年} 年才成立，对不上（也可能是前身公司的年头，问一句）` };
}

export function 域名项(域: string | undefined, 年: 域名年龄 | Error | null): 核验项 {
  if (!域) return { key: "domain", 灯: "yellow", 态: "没查到", 事实: "没找到官网，域名没法查" };
  if (!年 || 年 instanceof Error) return { key: "domain", 灯: "gray", 态: "查不了", 事实: `${域} 的注册时间这会儿查不了` };
  if (!年.有)
    return 年.查不了
      ? { key: "domain", 灯: "gray", 态: "查不了", 事实: `${域} 的注册时间这会儿查不了` }
      : { key: "domain", 灯: "yellow", 态: "没查到", 事实: `${域} 查不到注册时间，网上也没有它的网站存档和证书记录` };
  const 天 = 天数(年.日期);
  const 年数 = Math.floor(天 / 365);
  const 依据 = 年.依据 === "RDAP" ? `注册于 ${年.日期}（RDAP）` : 年.依据 === "Wayback" ? `注册日期不公开；网站最早存档 ${年.日期}（Wayback）` : `注册日期不公开；最早的 HTTPS 证书 ${年.日期}（证书透明日志）`;
  const 链接 = [{ title: 年.依据 === "RDAP" ? `${域} 的 RDAP 记录` : 年.依据 === "Wayback" ? `${域} 最早的网站存档` : `${域} 的证书记录`, url: 年.链接 }];
  const 至少 = 年.下限 ? "至少 " : "";
  if (天 >= 730) return { key: "domain", 灯: "green", 态: "已核", 事实: `${域} ${依据}，${至少}${年数} 年`, 链接 };
  if (天 >= 90) return { key: "domain", 灯: "yellow", 态: "已核", 事实: `${域} ${依据}，${至少}${天} 天，不到 2 年`, 链接 };
  return { key: "domain", 灯: "yellow", 态: "已核", 事实: `${域} ${依据}，才 ${天} 天`, 链接, 新域名: true };
}

/** 一项挂了（意外的错）：那一项「查不了」，别的照常 */
function 兜(key: 核验键, 事: string) {
  return (e: unknown): 核验项 => {
    console.warn(`[research/verify] ${key} 出错：`, e instanceof Error ? e.message : e);
    return { key, 灯: "gray", 态: "查不了", 事实: 事 };
  };
}

export async function 核验(请求: Omit<核验请求, "runId">, 依赖: 核验依赖 = {}): Promise<核验回应> {
  const 域 = 请求.域名 ? 主域名(请求.域名) : undefined;
  const 查年龄 = 依赖.查年龄 ?? 查域名年龄;
  const 名字们 = [...new Set([请求.公司, ...(请求.别名 ?? [])].map((x) => x?.trim()).filter((x): x is string => Boolean(x)))].slice(0, 3);
  // 域名年龄邮箱那一项也要用（像官网的邮箱域名看注册多久）：同一个域名只查一次
  const 年龄缓存 = new Map<string, Promise<域名年龄>>();
  const 年龄 = (d: string) => {
    if (!年龄缓存.has(d)) 年龄缓存.set(d, 查年龄(d));
    return 年龄缓存.get(d)!;
  };
  const 名单们 = (依赖.取名单 ?? (() => 取名单()))().catch(() => [] as 名单[]);
  // 英国公司查 HMRC 进口商名录（免费、不用 key）。查不了不当「没有」：undefined，报告里不写这一句
  const 进口们 =
    请求.国家 === "GB"
      ? (依赖.查进口 ?? 查英国进口)(名字们, 依赖.signal).catch((e: unknown) => {
          if (!(e instanceof 查不了)) console.warn("[research/verify] 进口记录出错：", e instanceof Error ? e.message : e);
          return undefined;
        })
      : Promise.resolve(undefined);

  const [domain, site, email, phone, sanctions, registry, vat] = await Promise.all([
    域 ? 年龄(域).then((y) => 域名项(域, y), (e: unknown) => 域名项(域, e instanceof Error ? e : new Error(String(e)))) : Promise.resolve(域名项(undefined, null)),
    域 ? (依赖.查官网 ?? 查官网)(域, 名字们, 依赖.signal, { 放行代理假IP: 依赖.放行代理假IP }).catch(兜("site", `${域} 这会儿查不了`)) : Promise.resolve<核验项>({ key: "site", 灯: "yellow", 态: "没查到", 事实: "没找到官网" }),
    查邮箱(请求.邮箱 ?? [], 域, { 查MX: 依赖.查MX ?? 默认查MX, 查年龄: 年龄 }).catch(兜("email", "邮箱这会儿查不了")),
    Promise.resolve().then(() => 查电话(请求.电话 ?? [], 请求.国家, 请求.自报国家)).catch(兜("phone", "电话这会儿查不了")),
    名单们.then((单) => 制裁项(单, 名字们, 请求.国家)).catch(兜("sanctions", "制裁名单这会儿查不了")),
    (依赖.查工商 ?? 查工商)(名字们, 请求.国家, { signal: 依赖.signal, 税号: 请求.税号 }).catch(兜("registry", "工商库这会儿查不了")),
    (依赖.查税号 ?? 查税号)(请求.税号, 请求.公司, 依赖.signal).catch(兜("vat", "税号这会儿查不了")),
  ]);
  const 单 = await 名单们;
  const 更 = 单.map((x) => x.更新于).sort()[0];
  const 进口 = await 进口们;
  return { 项: [registry, vat, domain, 比官网说法(site, registry), email, phone, sanctions], ...(更 ? { 名单更新于: 更 } : {}), ...(进口 !== undefined ? { 进口 } : {}) };
}
