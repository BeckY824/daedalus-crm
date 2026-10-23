/**
 * 制裁名单：美国 OFAC SDN、欧盟统一制裁名单、联合国安理会名单、英国制裁名单（FCDO）。都是官方免费下载。
 *
 * 服务器每天拉一次（第一次用到时、过了 24 小时再用到时，在后台拉），解析成「名字 + 国家」的小表存在缓存目录，
 * 本地按名字比。只收单位（公司、组织），不收个人和船——我们背调的是公司。
 *
 * 误报控制（方案 2.1）：名字规整以后一字不差、**国家也对上**才标红（疑似命中），并给出名单原文链接让人自己看；
 * 名字一样但国家对不上 / 名单上没写国家，标黄「同名，请人工看一眼」。名字只是像（多几个词）的不报——太吵。
 *
 * 英国：OFSI 的 ConList.csv 10-18 看停在 2026-06-03，改用 FCDO 的 UK Sanctions List（每周更新）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { 认国家, 国名 } from "./country";
import { 名词 } from "./names";
import { 标识 } from "./net";
import type { 核验项 } from "./types";

export type 名单名 = "OFAC" | "EU" | "UN" | "UK";
export const 名单中文: Record<名单名, string> = { OFAC: "美国 OFAC", EU: "欧盟", UN: "联合国", UK: "英国" };

/** 一个被制裁的单位：几个名字（主名 + 别名）、几个国家（ISO 两位码）、名单原文链接 */
export type 制裁条 = { 名: string[]; 国: string[]; 链: string; 号: string };
export type 名单 = { 名: 名单名; 更新于: string; 条: 制裁条[] };

const 来源: Record<名单名, { url: string; 编码: "utf-8" | "latin1" }> = {
  OFAC: { url: "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV", 编码: "latin1" },
  EU: { url: "https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw", 编码: "utf-8" },
  UN: { url: "https://scsanctions.un.org/resources/xml/en/consolidated.xml", 编码: "utf-8" },
  UK: { url: "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv", 编码: "utf-8" },
};
const OFAC附 = {
  地址: "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADD.CSV",
  别名: "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV",
};

/* ---------------- CSV：边下边解（英国那份 50 MB，整份读进来再切太占内存） ---------------- */

export class CSV流 {
  private 格 = "";
  private 行: string[] = [];
  private 引号里 = false;
  private 刚出引号 = false;
  constructor(
    private 分隔: string,
    private 每行: (row: string[]) => void,
  ) {}
  推(块: string) {
    for (let i = 0; i < 块.length; i++) {
      const c = 块[i];
      if (this.引号里) {
        if (c === '"') {
          this.引号里 = false;
          this.刚出引号 = true;
        } else this.格 += c;
        continue;
      }
      if (c === '"') {
        // 连着两个引号是转义的一个引号
        if (this.刚出引号) this.格 += '"';
        this.引号里 = true;
        this.刚出引号 = false;
        continue;
      }
      this.刚出引号 = false;
      if (c === this.分隔) {
        this.行.push(this.格);
        this.格 = "";
      } else if (c === "\n") {
        this.行.push(this.格.replace(/\r$/, ""));
        this.每行(this.行);
        this.行 = [];
        this.格 = "";
      } else this.格 += c;
    }
  }
  完() {
    if (this.格 || this.行.length) {
      this.行.push(this.格.replace(/\r$/, ""));
      this.每行(this.行);
    }
    this.行 = [];
    this.格 = "";
  }
}

export function 解CSV(text: string, 分隔 = ","): string[][] {
  const 出: string[][] = [];
  const p = new CSV流(分隔, (r) => 出.push(r));
  p.推(text);
  p.完();
  return 出;
}

const 空 = (s: string | undefined) => !s || s.trim() === "-0-" || s.trim() === "";

/* ---------------- 四份名单各自的格式 ---------------- */

/** OFAC：SDN.CSV（编号、名字、类型、项目……类型 -0- 是单位）+ ADD.CSV（地址，带国家）+ ALT.CSV（别名） */
export function 解OFAC(sdn: string, add: string, alt: string): 制裁条[] {
  const 条 = new Map<string, 制裁条>();
  for (const r of 解CSV(sdn)) {
    if (r.length < 3 || !/^\d+$/.test(r[0].trim()) || !空(r[2])) continue;
    条.set(r[0].trim(), { 名: [r[1].trim()], 国: [], 链: `https://sanctionssearch.ofac.treas.gov/Details.aspx?id=${r[0].trim()}`, 号: `OFAC ${r[0].trim()}` });
  }
  for (const r of 解CSV(add)) {
    const x = 条.get(r[0]?.trim());
    const 国 = 认国家(r[4]);
    if (x && 国 && !x.国.includes(国)) x.国.push(国);
  }
  for (const r of 解CSV(alt)) {
    const x = 条.get(r[0]?.trim());
    if (x && !空(r[3])) x.名.push(r[3].trim());
  }
  return [...条.values()];
}

/** 欧盟：一行是「单位 × 一个别名 × 一个地址」的组合，按 Entity_LogicalId 合并；只收 enterprise */
export function 解EU行(): { 行: (r: string[]) => void; 完: () => 制裁条[] } {
  let 头: string[] | null = null;
  const 条 = new Map<string, 制裁条>();
  return {
    行(r) {
      if (!头) {
        头 = r.map((x) => x.replace(/^﻿/, "").trim());
        return;
      }
      const 取 = (k: string) => r[头!.indexOf(k)] ?? "";
      if (取("Entity_SubjectType_ClassificationCode") !== "enterprise") return;
      const id = 取("Entity_LogicalId");
      let x = 条.get(id);
      if (!x) {
        x = { 名: [], 国: [], 链: 取("Entity_Regulation_PublicationUrl") || "https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions", 号: 取("Entity_EU_ReferenceNumber") || `EU ${id}` };
        条.set(id, x);
      }
      const 名 = 取("NameAlias_WholeName").trim();
      if (名 && !x.名.includes(名)) x.名.push(名);
      const 国 = 取("Address_CountryIso2Code").trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(国) && 国 !== "00" && !x.国.includes(国)) x.国.push(国);
    },
    完: () => [...条.values()].filter((x) => x.名.length),
  };
}

const 解实体 = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

/** 联合国：XML 里 <ENTITIES> 下每个 <ENTITY>：FIRST_NAME 是名字，ENTITY_ALIAS 是别名，ENTITY_ADDRESS 带国家 */
export function 解UN(xml: string): 制裁条[] {
  const 出: 制裁条[] = [];
  for (const m of xml.matchAll(/<ENTITY>([\s\S]*?)<\/ENTITY>/g)) {
    const b = m[1];
    const 取 = (tag: string) => [...b.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((x) => 解实体(x[1]).trim()).filter(Boolean);
    const 名 = [...取("FIRST_NAME"), ...取("ALIAS_NAME")];
    if (!名.length) continue;
    const 国 = [...new Set(取("COUNTRY").map((c) => 认国家(c)).filter((c): c is string => Boolean(c)))];
    出.push({ 名, 国, 链: "https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list", 号: `UN ${取("REFERENCE_NUMBER")[0] ?? 取("DATAID")[0] ?? ""}`.trim() });
  }
  return 出;
}

/** 英国（FCDO）：第一行是「Report Date: …」，第二行才是表头；Designation Type = Entity 的才收，Unique ID 合并 */
export function 解UK行(): { 行: (r: string[]) => void; 完: () => 制裁条[] } {
  let 头: string[] | null = null;
  const 条 = new Map<string, 制裁条>();
  return {
    行(r) {
      if (!头) {
        if (r.some((x) => x.trim() === "Unique ID")) 头 = r.map((x) => x.replace(/^﻿/, "").trim());
        return;
      }
      const 取 = (k: string) => r[头!.indexOf(k)] ?? "";
      if (取("Designation Type").trim() !== "Entity") return;
      const id = 取("Unique ID").trim();
      if (!id) return;
      let x = 条.get(id);
      if (!x) {
        x = { 名: [], 国: [], 链: "https://www.gov.uk/government/publications/the-uk-sanctions-list", 号: `UK ${id}` };
        条.set(id, x);
      }
      const 名 = ["Name 6", "Name 1", "Name 2", "Name 3", "Name 4", "Name 5"].map(取).filter((s) => s.trim()).join(" ").trim();
      if (名 && !x.名.includes(名)) x.名.push(名);
      const 国 = 认国家(取("Address Country"));
      if (国 && !x.国.includes(国)) x.国.push(国);
    },
    完: () => [...条.values()].filter((x) => x.名.length),
  };
}

/* ---------------- 下载、缓存 ---------------- */

export function 缓存目录(env: Record<string, string | undefined> = process.env): string {
  if (env.RESEARCH_CACHE_DIR?.trim()) return env.RESEARCH_CACHE_DIR.trim();
  // 服务器（Docker）上 /data 是数据卷，重启不丢；别的地方放临时目录
  return existsSync("/data") ? "/data/research-cache" : path.join(tmpdir(), "crm-research-cache");
}

async function 下载流(url: string, 编码: "utf-8" | "latin1", 每块: (s: string) => void): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": 标识 }, signal: AbortSignal.timeout(180_000), redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`下载失败（${res.status}）`);
  const 解 = new TextDecoder(编码 === "latin1" ? "latin1" : "utf-8");
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    每块(解.decode(value, { stream: true }));
  }
  每块(解.decode());
}

async function 下载文本(url: string, 编码: "utf-8" | "latin1"): Promise<string> {
  let s = "";
  await 下载流(url, 编码, (x) => (s += x));
  return s;
}

export async function 下载名单(名: 名单名): Promise<名单> {
  const 源 = 来源[名];
  let 条: 制裁条[];
  if (名 === "OFAC") {
    const [sdn, add, alt] = await Promise.all([下载文本(源.url, "latin1"), 下载文本(OFAC附.地址, "latin1"), 下载文本(OFAC附.别名, "latin1")]);
    条 = 解OFAC(sdn, add, alt);
  } else if (名 === "UN") {
    条 = 解UN(await 下载文本(源.url, "utf-8"));
  } else {
    const p = 名 === "EU" ? 解EU行() : 解UK行();
    const csv = new CSV流(名 === "EU" ? ";" : ",", p.行);
    await 下载流(源.url, 源.编码, (s) => csv.推(s));
    csv.完();
    条 = p.完();
  }
  // 解出来太少多半是对方改了格式：宁可当这份没下成（继续用旧的），也不要拿一份空名单说「未命中」
  if (条.length < (名 === "UN" ? 50 : 500)) throw new Error(`${名单中文[名]}名单只解出 ${条.length} 条，格式可能变了`);
  return { 名, 更新于: new Date().toISOString(), 条 };
}

const 全部名单: 名单名[] = ["OFAC", "EU", "UN", "UK"];
const 内存 = new Map<名单名, 名单>();
let 同步中: Promise<void> | null = null;
const 一天 = 86400_000;

function 读缓存(目录: string) {
  for (const 名 of 全部名单) {
    if (内存.has(名)) continue;
    const f = path.join(目录, `sanctions-${名.toLowerCase()}.json`);
    try {
      if (existsSync(f)) 内存.set(名, JSON.parse(readFileSync(f, "utf8")) as 名单);
    } catch {
      /* 缓存坏了：当没有，下面重新下 */
    }
  }
}

/** 拉一遍四份名单：哪份失败就留着那份旧的，不影响别的 */
export function 同步名单(目录 = 缓存目录(), 下载 = 下载名单): Promise<void> {
  if (同步中) return 同步中;
  同步中 = (async () => {
    await Promise.all(
      全部名单.map(async (名) => {
        try {
          const 单 = await 下载(名);
          内存.set(名, 单);
          try {
            mkdirSync(目录, { recursive: true });
            writeFileSync(path.join(目录, `sanctions-${名.toLowerCase()}.json`), JSON.stringify(单));
          } catch (e) {
            console.warn("[research/verify] 制裁名单缓存没写上：", e instanceof Error ? e.message : e);
          }
        } catch (e) {
          console.warn(`[research/verify] ${名单中文[名]}制裁名单没下下来：`, e instanceof Error ? e.message : e);
        }
      }),
    );
  })().finally(() => {
    同步中 = null;
  });
  return 同步中;
}

/**
 * 拿到能用的名单：内存 → 缓存文件；过了一天就在后台拉新的（这次先用旧的）。
 * 一份都没有（第一次）就等它下，最多等 等秒 秒——等不到这次就「查不了」
 */
export async function 取名单(opts: { 目录?: string; 等秒?: number; 下载?: typeof 下载名单 } = {}): Promise<名单[]> {
  const 目录 = opts.目录 ?? 缓存目录();
  读缓存(目录);
  const 有 = 全部名单.map((n) => 内存.get(n)).filter((x): x is 名单 => Boolean(x));
  const 旧 = 有.length < 全部名单.length || 有.some((x) => Date.now() - Date.parse(x.更新于) > 一天);
  if (旧) {
    const p = 同步名单(目录, opts.下载);
    if (!有.length) await Promise.race([p, new Promise((r) => setTimeout(r, (opts.等秒 ?? 20) * 1000))]);
  }
  return 全部名单.map((n) => 内存.get(n)).filter((x): x is 名单 => Boolean(x));
}

/* ---------------- 比对 ---------------- */

export type 命中 = { 名单: 名单名; 名: string; 国: string[]; 链: string; 号: string; 国家对上: boolean };

/** 名字规整以后连写（「同」的判断等价于连写相等，见 names.ts 比名字）→ 那几条。每份名单建一次 */
const 索引缓存 = new WeakMap<名单, Map<string, { 条: 制裁条; 名: string }[]>>();
function 索引(单: 名单) {
  let m = 索引缓存.get(单);
  if (m) return m;
  m = new Map();
  for (const x of 单.条)
    for (const n of x.名) {
      const k = 名词(n).join("");
      if (k.length < 2) continue;
      const 列 = m.get(k) ?? [];
      if (!列.some((y) => y.条 === x)) 列.push({ 条: x, 名: n });
      m.set(k, 列);
    }
  索引缓存.set(单, m);
  return m;
}

export function 比名单(名单们: 名单[], 名字们: string[], 国家?: string): 命中[] {
  const 键 = [...new Set(名字们.map((n) => 名词(n).join("")).filter((k) => k.length >= 2))];
  const 出: 命中[] = [];
  for (const 单 of 名单们) {
    const m = 索引(单);
    const 见 = new Set<制裁条>();
    for (const k of 键)
      for (const { 条: x, 名 } of m.get(k) ?? []) {
        if (见.has(x)) continue;
        见.add(x);
        出.push({ 名单: 单.名, 名, 国: x.国, 链: x.链, 号: x.号, 国家对上: Boolean(国家 && x.国.includes(国家)) });
      }
  }
  // 国家对上的排前面
  return 出.sort((a, b) => Number(b.国家对上) - Number(a.国家对上));
}

export function 制裁项(名单们: 名单[], 名字们: string[], 国家?: string): 核验项 {
  if (!名单们.length) return { key: "sanctions", 灯: "gray", 态: "查不了", 事实: "制裁名单还没下载下来（服务器第一次用要几分钟），这次没查" };
  const 中 = 比名单(名单们, 名字们, 国家);
  const 哪些 = 名单们.map((x) => 名单中文[x.名]).join(" / ");
  const 缺 = 全部名单.filter((n) => !名单们.some((x) => x.名 === n)).map((n) => 名单中文[n]);
  const 日 = 名单们.map((x) => x.更新于).sort()[0]?.slice(5, 10);
  const 尾 = `（名单更新于 ${日}${缺.length ? `；${缺.join("、")}名单这次没下下来` : ""}）`;
  if (!中.length) return { key: "sanctions", 灯: "green", 态: "已核", 事实: `${哪些}：未命中${尾}` };
  const 链接 = 中.slice(0, 3).map((h) => ({ title: `${名单中文[h.名单]}：${h.名}（${h.号}）`, url: h.链 }));
  const 实 = 中.find((h) => h.国家对上);
  if (实) {
    const 句 = `${名单中文[实.名单]}名单上有同名单位「${实.名}」，国家也是${国名(国家)}`;
    return { key: "sanctions", 灯: "red", 态: "已核", 事实: `疑似命中：${句}，请点名单原文核对${尾}`, 硬红: `制裁名单疑似命中（${句}）`, 链接 };
  }
  const h = 中[0];
  return {
    key: "sanctions",
    灯: "yellow",
    态: "已核",
    事实: `${名单中文[h.名单]}名单上有同名单位「${h.名}」${h.国.length ? `，登记在${h.国.map(国名).join("、")}` : "，名单上没写国家"}，和这家${国家 ? "国家对不上" : "国家没法比"}，多半只是同名，请人工看一眼${尾}`,
    链接,
  };
}
