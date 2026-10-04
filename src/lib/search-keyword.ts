/**
 * 列表页搜索框的关键词怎么用（2026-10-04 J-008）。
 *
 * 原来关键词原样丢给 Prisma 的 contains，三处对不上人的直觉：
 * 1. 不 trim：从微信里复制来的「张三 」带个空格，一个都搜不到，人以为客户不在，转头再建一份——造出重复档案；
 * 2. 号码带空格：人照名片念着敲「138 0000」，库里存的是规整过的「13800001111」（lib/phone.ts），对不上；
 * 3. SQLite 的 LIKE 里 % 和 _ 是通配符，Prisma 不转义：搜「100%」把「100分客户」也搜出来，搜「a_b」连「axb」也算。
 */
import { prisma } from "./prisma";

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

/**
 * 关键词里带 % 或 _ 时，按「字面包含」找出 id（instr 不认通配符）。Prisma 的 contains 没法加 ESCAPE，只能走原生 SQL。
 * 表名、列名只从调用方的常量来，关键词走参数绑定。lower 两边和 LIKE 一样只管 ASCII 的大小写。
 * 只拿 id 当过滤条件，权限限定（lib/team-scope.ts）仍在后面的 findMany 上生效。
 */
export async function 字面包含的id(表: "Customer", 列们: readonly string[], k: string): Promise<string[]> {
  const 条件 = 列们.map((c) => `instr(lower("${c}"), lower(?)) > 0`).join(" OR ");
  const 行 = await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "${表}" WHERE ${条件}`, ...列们.map(() => k));
  return 行.map((r) => r.id);
}
