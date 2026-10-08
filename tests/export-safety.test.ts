import { it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { csvCell } from "@/lib/csv";
import { 写xlsx } from "@/lib/xlsx-write";
it("CSV前导空白后的公式也必须作为文本，原字保留", () => {
  for (const s of [" =1+1", "   +SUM(A1)", " \t@SUM(A1)", "\n=1+1", "\uFEFF=1+1", "\u00a0-1"]) expect(csvCell(s).startsWith("\"'"), JSON.stringify(s)).toBe(true);
  expect(csvCell("普通 = 文字")).toBe('"普通 = 文字"');
});
it("xlsx表名规范化后再去重，空白外的引号和截断产生的尾引号均删除", () => {
  const sheets = [" '名单' ", "名单", "A".repeat(30)+"'后缀", "Sheet", "sheet", "😀".repeat(32), "合法\u0000名字", "合法名字"];
  const zip = unzipSync(写xlsx(sheets.map(名 => ({ 名, 表头: ["备注"], 行: [[" =1+1"]] }))));
  const names = [...strFromU8(zip["xl/workbook.xml"]).matchAll(/<sheet name="([^"]+)"/g)].map(m=>m[1]);
  expect(names[0]).toBe("名单"); expect(names[1]).not.toBe(names[0]);
  expect(names.every(n => !n.startsWith("'") && !n.endsWith("'"))).toBe(true);
  expect(new Set(names.map(n=>n.toLowerCase())).size).toBe(names.length);
  expect(names[5]).not.toContain("�");
  for (const key of Object.keys(zip).filter(k=>/worksheets\/.+xml$/.test(k))) {
    const xml = strFromU8(zip[key]); expect(xml).toContain('t="inlineStr"'); expect(xml).not.toContain("<f>"); expect(xml).toContain(" =1+1");
  }
});
it("导出使用的本地日期格式在上海凌晨和纽约跨日边界不取UTC日期", async () => {
  const { fmtDate } = await import("@/lib/utils");
  const tz = process.env.TZ;
  try {
    process.env.TZ = "Asia/Shanghai"; expect(fmtDate(new Date("2026-10-08T00:30:00+08:00"))).toBe("2026-10-08");
    process.env.TZ = "America/New_York"; expect(fmtDate(new Date("2026-10-08T01:00:00Z"))).toBe("2026-10-07");
  } finally { process.env.TZ = tz; }
});
