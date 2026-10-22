/**
 * 域名注册多久了。三条路，按可信度依次退：
 *   1. RDAP（WHOIS 的新标准）：先按 IANA 的引导表找这个后缀的 RDAP 服务器。.com / .net / .uk / .fr 都给注册日期；
 *      **.de（DENIC）只给最后修改日期，不给注册日期**（10-18 实测），.it / .es / .ae 等没有公开 RDAP
 *   2. Wayback Machine 的 CDX：网站最早一次被存档是什么时候——只能当下限（「至少那时就有了」）
 *   3. crt.sh：第一次签 HTTPS 证书的时间，同样是下限
 * 都是免费的公益 / 官方服务，偶尔慢或挂：每条都带超时，挂了就往下退，全挂就是「查不了」。
 */
import { 取JSON, 查不了 } from "./net";

/** IANA 引导表里没有、但实测有公开 RDAP 的后缀 */
const 补充服务器: Record<string, string> = { de: "https://rdap.denic.de/", ch: "https://rdap.nic.ch/", li: "https://rdap.nic.ch/" };

let 引导: { at: number; 表: Map<string, string> } | null = null;

async function RDAP服务器(后缀: string): Promise<string | undefined> {
  if (!引导 || Date.now() - 引导.at > 86400_000) {
    const r = await 取JSON<{ services?: [string[], string[]][] }>("https://data.iana.org/rdap/dns.json", { 秒: 8 });
    const 表 = new Map<string, string>();
    for (const [tlds, urls] of r.data?.services ?? []) for (const t of tlds) if (urls[0]) 表.set(t.toLowerCase(), urls.find((u) => u.startsWith("https://")) ?? urls[0]);
    引导 = { at: Date.now(), 表 };
  }
  return 引导.表.get(后缀) ?? 补充服务器[后缀];
}

export type 域名年龄 =
  | { 有: true; 日期: string; 依据: "RDAP" | "Wayback" | "证书"; 下限: boolean; 链接: string }
  | { 有: false; 查不了: boolean };

async function 按RDAP(域: string): Promise<{ 日期?: string; 链接: string } | null> {
  const 后缀 = 域.split(".").pop()!;
  const base = await RDAP服务器(后缀);
  if (!base) return null;
  const url = `${base.replace(/\/+$/, "")}/domain/${encodeURIComponent(域)}`;
  const r = await 取JSON<{ events?: { eventAction?: string; eventDate?: string }[] }>(url, { 秒: 8, headers: { Accept: "application/rdap+json, application/json" } });
  const 注册 = r.data?.events?.find((e) => e.eventAction === "registration")?.eventDate;
  return { 日期: 注册 && !Number.isNaN(Date.parse(注册)) ? 注册.slice(0, 10) : undefined, 链接: url };
}

async function 按存档(域: string): Promise<string | null> {
  const r = await 取JSON<string[][]>(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(域)}&limit=1&output=json&fl=timestamp`, { 秒: 10 });
  const ts = r.data?.[1]?.[0];
  return ts && /^\d{8}/.test(ts) ? ts : null;
}

async function 按证书(域: string): Promise<string | null> {
  const r = await 取JSON<{ not_before?: string }[]>(`https://crt.sh/?q=${encodeURIComponent(域)}&output=json`, { 秒: 12 });
  const 日 = (r.data ?? []).map((x) => x.not_before).filter((x): x is string => Boolean(x && !Number.isNaN(Date.parse(x)))).sort();
  return 日[0]?.slice(0, 10) ?? null;
}

export async function 查域名年龄(域: string): Promise<域名年龄> {
  let 挂了 = 0;
  try {
    const r = await 按RDAP(域);
    if (r?.日期) return { 有: true, 日期: r.日期, 依据: "RDAP", 下限: false, 链接: r.链接 };
  } catch (e) {
    if (!(e instanceof 查不了)) throw e;
    挂了++;
  }
  try {
    const ts = await 按存档(域);
    if (ts) return { 有: true, 日期: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`, 依据: "Wayback", 下限: true, 链接: `https://web.archive.org/web/${ts}/${域}` };
  } catch (e) {
    if (!(e instanceof 查不了)) throw e;
    挂了++;
  }
  try {
    const d = await 按证书(域);
    if (d) return { 有: true, 日期: d, 依据: "证书", 下限: true, 链接: `https://crt.sh/?q=${encodeURIComponent(域)}` };
  } catch (e) {
    if (!(e instanceof 查不了)) throw e;
    挂了++;
  }
  // 存档和证书都确实没有（不是挂了）：这个域名几乎没在网上出现过
  return { 有: false, 查不了: 挂了 >= 2 };
}

export function 天数(日期: string, now = Date.now()): number {
  return Math.floor((now - Date.parse(日期)) / 86400_000);
}
