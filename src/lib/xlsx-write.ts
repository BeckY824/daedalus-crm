/**
 * 写一个最小的 .xlsx（2026-10-05，客户导出带上跟进记录）。浏览器里、服务端都能用，只靠 fflate 打包。
 *
 * 为什么不再是 CSV：外贸客户要「导出客户的时候把跟进记录也一并导出」。一位客户有几十条跟进，
 * CSV 一行一位客户装不下，挤进一格又没法看。xlsx 能放两张表：「客户」和原来一样（能原样导回来，
 * 导入只读第一张表，见 lib/import/xlsx.ts）、「跟进记录」一条跟进一行。
 * 顺带解决两件 CSV 的老毛病：Excel 打开不再靠 BOM 认中文；号码、「=」开头的备注都是文本格，
 * 不会被当成数字吃掉开头的 + 和 0，也不会被当成公式执行（inlineStr 永远是文本，不用像 CSV 那样前面垫单引号）。
 *
 * 只做导出要的：文本格（inlineStr）、表头加粗、冻结首行、列宽。不做合并、数字格式、公式。
 */
import { strToU8, zipSync } from "fflate";

export type 工作表 = { 名: string; 表头: readonly string[]; 行: readonly (readonly unknown[])[]; 列宽?: readonly number[] };

/** XML 里不许出现的控制字符（除了 \t \n \r）去掉，& < > " 转义 */
function 转义(v: unknown): string {
  const s = v == null ? "" : String(v);
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 第 n 列（从 0 起）的字母：0 → A，26 → AA */
export function 列字母(n: number): string {
  let s = "";
  for (let x = n + 1; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** 工作表名：Excel 限 31 个字，不许 \ / ? * [ ] :，不许以单引号开头或结尾（不然打开时提示「修复」） */
function 表名(s: string): string {
  return [...s.replace(/[\\/?*[\]:]/g, " ").replace(/^'+|'+$/g, "").trim()].slice(0, 31).join("") || "Sheet";
}

/** 一格最多 32767 个字（Excel 的上限，超了打不开），超了截掉、尾巴写明 */
const 格上限 = 32767;
function 格(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (s.length <= 格上限) return s;
  // 按 UTF-16 截可能切在 emoji 的半个代理对上，留下一个坏字符：退一位
  let 到 = 格上限 - 20;
  if (/[\uD800-\uDBFF]/.test(s[到 - 1] ?? "")) 到--;
  return `${s.slice(0, 到)}…（太长，后面截掉了）`;
}

function 表xml(t: 工作表): string {
  const 行们 = [t.表头, ...t.行];
  const 宽 = t.列宽 ?? t.表头.map((h) => Math.max(10, Math.min(40, String(h).length * 2 + 4)));
  const rows = 行们
    .map((r, i) => {
      const cells = r
        .map((v, j) => {
          const s = 格(v);
          if (!s) return "";
          // s="1"：表头那一行用加粗的样式（styles.xml 里第 2 个 cellXfs）
          return `<c r="${列字母(j)}${i + 1}" t="inlineStr"${i === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${转义(s)}</t></is></c>`;
        })
        .join("");
      return `<row r="${i + 1}">${cells}</row>`;
    })
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${宽.map((w, j) => `<col min="${j + 1}" max="${j + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` +
    `<sheetData>${rows}</sheetData>` +
    "</worksheet>"
  );
}

/** 几张表 → .xlsx 的字节 */
export function 写xlsx(表们: readonly 工作表[]): Uint8Array {
  const 名们: string[] = [];
  for (const t of 表们) {
    let n = 表名(t.名);
    // Excel 认表名不分大小写：「Sheet」和「sheet」算重名
    const 撞 = (x: string) => 名们.some((y) => y.toLowerCase() === x.toLowerCase());
    for (let k = 2; 撞(n); k++) n = `${[...表名(t.名)].slice(0, 28).join("")} ${k}`;
    名们.push(n);
  }
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        表们.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
        "</Types>",
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>",
    ),
    "xl/workbook.xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets>${名们.map((n, i) => `<sheet name="${转义(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>` +
        "</workbook>",
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        表们.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
        `<Relationship Id="rId${表们.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        "</Relationships>",
    ),
    "xl/styles.xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        "</styleSheet>",
    ),
  };
  表们.forEach((t, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(表xml(t))));
  return zipSync(files, { level: 6 });
}
