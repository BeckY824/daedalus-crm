/**
 * CSV 生成。
 *
 * 导出的去向是财务对账，所以三件事都不能出错：
 *
 * 1. **中文不能乱码**。Excel 打开 UTF-8 的 CSV 时不看编码声明，
 *    只认开头的 BOM。少了它，中文在 Excel 里就是一片乱码
 *    （在 VSCode / Numbers 里看却是好的，所以很容易漏掉）。
 *
 * 2. **逗号、引号、换行要转义**。字段一律用双引号包起来，
 *    内部的双引号写成两个——RFC 4180 的规矩。
 *
 * 3. **公式注入要挡住**。Excel 和 Google Sheets 会把以
 *    `=` `+` `-` `@` 开头的单元格当公式执行。备注、姓名这些字段是用户自由输入的，
 *    有人（哪怕是无意）填了 `=1+1` 或 `=HYPERLINK(...)`，
 *    对账的人一打开就会执行。做法是在前面加一个单引号，
 *    Excel 会把它当纯文本前缀显示而不会计算。
 */

/** Excel 认这个 BOM 才不会把中文显示成乱码 */
export const BOM = "﻿";

/** 这几个开头会被表格软件当成公式 */
const 危险开头 = ["=", "+", "-", "@", "\t", "\r"];

/** 单个字段：先挡公式注入，再按 RFC 4180 转义 */
export function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  const 安全 = 危险开头.some((c) => s.startsWith(c)) ? `'${s}` : s;
  return `"${安全.replace(/"/g, '""')}"`;
}

/**
 * 拼成完整的 CSV 文本（含 BOM）。
 * 行分隔用 \r\n：Excel 对 \n 的容忍度不如 \r\n，尤其是字段里本身带换行时。
 */
export function toCsv(head: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [head.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))];
  return BOM + lines.join("\r\n");
}
