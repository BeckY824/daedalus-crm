/**
 * 列表页搜索框的关键词怎么用（2026-10-04 J-008）。
 *
 * 原来关键词原样丢给 Prisma 的 contains，三处对不上人的直觉：
 * 1. 不 trim：从微信里复制来的「张三 」带个空格，一个都搜不到，人以为客户不在，转头再建一份——造出重复档案；
 * 2. 号码带空格：人照名片念着敲「138 0000」，库里存的是规整过的「13800001111」（lib/phone.ts），对不上；
 * 3. SQLite 的 LIKE 里 % 和 _ 是通配符，Prisma 不转义：搜「100%」把「100分客户」也搜出来，搜「a_b」连「axb」也算。
 */
import { 企业版 } from "./enterprise/switch";
import { 号键SQL } from "./phone-dedupe";
import { prisma } from "./prisma";
import type { Prisma } from "@/generated/prisma";

/** 去掉前后空白（含全角空格 U+3000，String.trim 本就认）。不是字符串的当没搜 */
export function 搜索词(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * 关键词像一段号码（只有数字、空格、横杠、括号、+，至少 3 位数字）时，给出拿去搜电话列的纯数字；不像返回 null。
 * 全角数字也认。库里电话是规整后的纯数字，所以只能拿纯数字去比
 */
export function 号码片段(k: string): string | null {
  const 半角 = k.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/＋/g, "+");
  if (!/^[\d\s\-+()（）－]+$/.test(半角)) return null;
  const 数字 = 半角.replace(/\D/g, "");
  // 完整大陆手机号去国家码，与保存规则相同；短片段和海外号不猜。
  const 规范 = 数字.replace(/^0*86(?=1[3-9]\d{9}$)/, "");
  return 规范.length >= 3 ? 规范 : null;
}

/**
 * 关键词像一个网址时，拿去比官网那一格的域名（2026-10-17 PR26 手测）。
 * 从「官网 ↗」打开、再从地址栏复制回来的是 https://www.acme.com/，或带着 /contact 这样的路径；
 * 库里存的是人填的 www.acme.com，原样包含匹配对不上。去掉协议、www.、端口、路径和末尾斜杠，小写。
 * 不像网址的（没有点、带空格、邮箱的 @）返回 null，官网那一格照原样比
 */
export function 网址域名(k: string): string | null {
  const m = /^(?:https?:\/\/)?(?:www\.)?([^\s/?#:@]+\.[^\s/?#:@.]{2,})(?::\d+)?(?:[/?#]\S*)?$/i.exec(k.trim());
  return m ? m[1].toLowerCase() : null;
}

// SQLite GLOB 按Unicode码点匹配，但不折叠大小写。字符组补齐单码点大小写等价类；
// 不把ß改成SS等多字符展开，不改变原文，也不要求旧库重新写入搜索索引。
let 大小写组: Map<string, Set<string>> | undefined;
function 大小写等价组() {
  if (大小写组) return 大小写组;
  const groups = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    if (a === b || [...b].length !== 1) return;
    const left = groups.get(a) ?? new Set([a]);
    const right = groups.get(b) ?? new Set([b]);
    for (const c of right) left.add(c);
    for (const c of left) groups.set(c, left);
  };
  for (let n = 0; n <= 0x10ffff; n++) {
    const c = String.fromCodePoint(n);
    connect(c, c.toLowerCase()); connect(c, c.toUpperCase());
  }
  大小写组 = groups;
  return groups;
}

function 包含模式(k: string): string {
  const groups = 大小写等价组();
  return "*" + [...k].map(c => {
    const variants = groups.get(c);
    if (variants) return `[${[...variants].join("")}]`;
    return c === "[" ? "[[]" : c === "]" ? "[]]" : c === "*" ? "[*]" : c === "?" ? "[?]" : c;
  }).join("") + "*";
}

/**
 * 企业版字段权限把电话设成「藏」的人，搜索也不按号码匹配（2026-10-26 Y27）。
 * 列表上号码打了码，可拿完整号码、前 7 位、后 4 位一搜还是能把人搜出来——等于从搜索框试出号码。
 * 客户 / 联系人 / 线索的电话、外贸档案的 WhatsApp 都算「电话」。姓名、邮箱等照常能搜。
 * 开关关着不读库，个人版、团队版（含共享区）照旧按号码搜。
 * userId 不给 = 当前登录的人；不走 cookie 的入口（AI 助手经 MCP 调）必须传
 */
export async function 号码藏着(userId?: string): Promise<boolean> {
  if (!企业版()) return false;
  const { 字段权限of } = await import("./enterprise/field-perm");
  return (await 字段权限of(userId))("电话") === "藏";
}

/** 小in组成一个OR，整条查询保留一次全局orderBy/skip/take。 */
export function 客户id集合(ids: readonly string[]): Prisma.CustomerWhereInput {
  const chunks: Prisma.CustomerWhereInput[] = [];
  for (let i=0;i<ids.length;i+=500) chunks.push({id:{in:ids.slice(i,i+500)}});
  return chunks.length ? {OR:chunks} : {id:{in:[]}};
}

/** 仅内置列名参与SQL；值全部参数绑定。最终模型查询继续经过租户/业务员限定。 */
export async function 客户关键词条件(raw: unknown, onlyPicker = false, userId?: string): Promise<Prisma.CustomerWhereInput> {
  const k = 搜索词(raw);
  if (!k) return {};
  const 藏号 = await 号码藏着(userId);
  const phone = 号码片段(k);
  const pattern = 包含模式(k), phonePattern = 包含模式(phone ?? k), sitePattern = 包含模式(网址域名(k) ?? k);
  const fields = onlyPicker ? ["name", "school"] : ["name", "school", "major", "grade", "remark"];
  const parts = fields.map(c => `c."${c}" GLOB ?`);
  const values = fields.map(() => pattern);
  if (!藏号) {
    parts.push('c."phone" GLOB ?'); values.push(phonePattern);
    if (phone) { parts.push(`${号键SQL('c."phone"')} GLOB ?`); values.push(phonePattern); }
  }
  if (!onlyPicker) {
    // 电话藏着时 WhatsApp、联系人电话两列不进条件（Y27）
    const 号值 = 藏号 ? [] : [pattern, phonePattern];
    // 三张子表用不相关的 IN 子查询：SQLite 各扫一遍、记成一张表，每个客户只查表。
    // 原来写 EXISTS（按 customerId 相关），没被本表列命中的每个客户都要回子表各查一次；
    // 10 万客户一次搜索 ~50 ms → ~26 ms，带扩展资料/联系人的库 ~140 → ~60 ms。customerId 三张表都非空，结果和 EXISTS 一样（2026-10-26）
    parts.push(`c.id IN (SELECT e."customerId" FROM "CustomerExtra" e WHERE ${藏号 ? "" : "e.whatsapp GLOB ? OR e.whatsapp GLOB ? OR "}e.email GLOB ? OR e.wechat GLOB ? OR e.country GLOB ? OR e.website GLOB ? OR e."alibabaId" GLOB ?)`);
    values.push(...号值,pattern,pattern,pattern,sitePattern,pattern);
    parts.push(`c.id IN (SELECT t."customerId" FROM "Contact" t WHERE t.name GLOB ? OR ${藏号 ? "" : "t.phone GLOB ? OR t.phone GLOB ? OR "}t.email GLOB ? OR t.wechat GLOB ?)`);
    values.push(pattern,...号值,pattern,pattern);
    parts.push('c.id IN (SELECT o."customerId" FROM "TradeOrder" o WHERE o.no GLOB ?)'); values.push(pattern);
  }
  const rows = await prisma.$queryRawUnsafe<{id:string}[]>(`SELECT c.id FROM "Customer" c WHERE ${parts.join(" OR ")}`, ...values);
  // 避免Prisma把一个超长in拆成多条各自skip的查询，导致后页静默变空。
  return 客户id集合(rows.map(r=>r.id));
}

/** 线索与客户共用号码片段/Unicode字面规则；裸查询仅取ID，最终列表仍走权限限定。 */
export async function 线索关键词条件(raw: unknown, userId?: string): Promise<Prisma.LeadWhereInput> {
  const k = 搜索词(raw);
  if (!k) return {};
  const 藏号 = await 号码藏着(userId);
  const phone = 号码片段(k);
  const pattern = 包含模式(k);
  const parts = ["name", "contact", "email", "industry", "remark"].map(c => `l."${c}" GLOB ?`);
  const values = parts.map(() => pattern);
  if (!藏号) {
    parts.push('l."phone" GLOB ?'); values.push(包含模式(phone ?? k));
    if (phone) { parts.push(`${号键SQL('l."phone"')} GLOB ?`); values.push(包含模式(phone)); }
  }
  const rows = await prisma.$queryRawUnsafe<{id:string}[]>(`SELECT l.id FROM "Lead" l WHERE ${parts.join(" OR ")}`, ...values);
  const chunks: Prisma.LeadWhereInput[] = [];
  for (let i=0;i<rows.length;i+=500) chunks.push({id:{in:rows.slice(i,i+500).map(r=>r.id)}});
  return chunks.length ? {OR:chunks} : {id:{in:[]}};
}
