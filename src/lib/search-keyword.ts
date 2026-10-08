/**
 * 列表页搜索框的关键词怎么用（2026-10-04 J-008）。
 *
 * 原来关键词原样丢给 Prisma 的 contains，三处对不上人的直觉：
 * 1. 不 trim：从微信里复制来的「张三 」带个空格，一个都搜不到，人以为客户不在，转头再建一份——造出重复档案；
 * 2. 号码带空格：人照名片念着敲「138 0000」，库里存的是规整过的「13800001111」（lib/phone.ts），对不上；
 * 3. SQLite 的 LIKE 里 % 和 _ 是通配符，Prisma 不转义：搜「100%」把「100分客户」也搜出来，搜「a_b」连「axb」也算。
 */
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
  return 数字.length >= 3 ? 数字 : null;
}

export function 有通配符(k: string): boolean {
  return /[%_]/.test(k);
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

/** 小in组成一个OR，整条查询保留一次全局orderBy/skip/take。 */
export function 客户id集合(ids: readonly string[]): Prisma.CustomerWhereInput {
  const chunks: Prisma.CustomerWhereInput[] = [];
  for (let i=0;i<ids.length;i+=500) chunks.push({id:{in:ids.slice(i,i+500)}});
  return chunks.length ? {OR:chunks} : {id:{in:[]}};
}

/** 仅内置列名参与SQL；值全部参数绑定。最终模型查询继续经过租户/业务员限定。 */
export async function 客户关键词条件(raw: unknown, onlyPicker = false): Promise<Prisma.CustomerWhereInput> {
  const k = 搜索词(raw);
  if (!k) return {};
  const phone = 号码片段(k);
  const pattern = 包含模式(k), phonePattern = 包含模式(phone ?? k);
  const fields = onlyPicker ? ["name", "school"] : ["name", "school", "major", "grade", "remark"];
  const parts = fields.map(c => `c."${c}" GLOB ?`);
  const values = fields.map(() => pattern);
  parts.push('c."phone" GLOB ?'); values.push(phonePattern);
  if (!onlyPicker) {
    parts.push('EXISTS (SELECT 1 FROM "CustomerExtra" e WHERE e."customerId"=c.id AND (e.whatsapp GLOB ? OR e.whatsapp GLOB ? OR e.email GLOB ? OR e.wechat GLOB ? OR e.country GLOB ?))');
    values.push(pattern,phonePattern,pattern,pattern,pattern);
    parts.push('EXISTS (SELECT 1 FROM "Contact" t WHERE t."customerId"=c.id AND (t.name GLOB ? OR t.phone GLOB ? OR t.phone GLOB ? OR t.email GLOB ? OR t.wechat GLOB ?))');
    values.push(pattern,pattern,phonePattern,pattern,pattern);
    parts.push('EXISTS (SELECT 1 FROM "TradeOrder" o WHERE o."customerId"=c.id AND o.no GLOB ?)'); values.push(pattern);
  }
  const rows = await prisma.$queryRawUnsafe<{id:string}[]>(`SELECT c.id FROM "Customer" c WHERE ${parts.join(" OR ")}`, ...values);
  // 避免Prisma把一个超长in拆成多条各自skip的查询，导致后页静默变空。
  return 客户id集合(rows.map(r=>r.id));
}
