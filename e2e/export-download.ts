import { expect } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { 读xlsx } from "../src/lib/import/xlsx";

/** 验真实下载包；逐份读内层工作簿，核对清单、条数、编号和客户/跟进关联。 */
export function 读取完整导出(bytes: Uint8Array) {
  const files = unzipSync(bytes);
  expect(files["阅读说明.txt"]).toBeTruthy();
  const 清单 = JSON.parse(strFromU8(files["导出清单.json"]));
  expect(Number.isFinite(Date.parse(清单.截止))).toBe(true);
  expect(Number.isFinite(Date.parse(清单.完成))).toBe(true);
  const tables: Record<string, string[][]> = { 客户: [], 跟进: [] };
  const xml: Record<string, string[]> = { 客户: [], 跟进: [] };
  const ids: Record<string, Set<string>> = { 客户: new Set(), 跟进: new Set() };
  const seen = new Set<string>();
  const 工作簿XML: string[] = [];
  const 工作表XML: { 名: string; 内容: string }[] = [];
  for (const part of 清单.分批 as { 文件: string; 类别: string; 条数: number; 首条ID: string; 尾条ID: string }[]) {
    expect(part.文件).toMatch(/^(客户|跟进)-\d{3,}\.xlsx$/);
    expect(part.文件.startsWith(part.类别 + "-")).toBe(true);
    expect(seen.has(part.文件)).toBe(false); seen.add(part.文件);
    const rows = 读xlsx(files[part.文件]);
    expect(rows.length).toBe(part.条数 + 1);
    const head = rows[0];
    if (tables[part.类别].length) expect(head).toEqual(tables[part.类别][0]);
    else tables[part.类别].push(head);
    tables[part.类别].push(...rows.slice(1));
    const idIndex = head.indexOf(part.类别 === "客户" ? "客户编号" : "跟进编号");
    expect(idIndex).toBeGreaterThanOrEqual(0);
    for (const row of rows.slice(1)) { expect(row[idIndex]).toBeTruthy(); expect(ids[part.类别].has(row[idIndex])).toBe(false); ids[part.类别].add(row[idIndex]); }
    expect(rows[1]?.[idIndex] ?? "").toBe(part.首条ID);
    expect(rows.at(-1)?.[idIndex] && rows.length > 1 ? rows.at(-1)![idIndex] : "").toBe(part.尾条ID);
    const inner = unzipSync(files[part.文件]);
    工作簿XML.push(strFromU8(inner["xl/workbook.xml"]));
    for (const [name, value] of Object.entries(inner)) if (name.startsWith("xl/worksheets/")) {
      const 内容 = strFromU8(value); xml[part.类别].push(内容); 工作表XML.push({ 名: `${part.文件}/${name}`, 内容 });
    }
  }
  expect(Object.keys(files).sort()).toEqual([...seen, "导出清单.json", "阅读说明.txt"].sort());
  expect(ids.客户.size).toBe(清单.客户数); expect(ids.跟进.size).toBe(清单.跟进数);
  const customerIndex = tables.跟进[0].indexOf("客户编号");
  expect(customerIndex).toBeGreaterThanOrEqual(0);
  for (const row of tables.跟进.slice(1)) expect(ids.客户.has(row[customerIndex])).toBe(true);
  return { 清单, 客户: tables.客户, 跟进: tables.跟进, 客户XML: xml.客户.join("\n"), 跟进XML: xml.跟进.join("\n"), 工作簿XML, 工作表XML };
}
