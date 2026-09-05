/**
 * CSV 导出。
 *
 * 导出的去向是财务对账——错一个字段，对账的人未必看得出来，
 * 但金额已经错了。三类问题各自都能悄悄毁掉一份表：
 * 中文乱码（只在 Excel 里可见）、转义错位（一个逗号错开整行）、
 * 公式注入（打开即执行）。
 */
import { describe, it, expect } from "vitest";
import { toCsv, csvCell, BOM } from "@/lib/csv";

describe("中文与编码", () => {
  it("必须带 BOM，否则 Excel 打开中文是乱码", () => {
    const csv = toCsv(["客户姓名"], [["张三"]]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.codePointAt(0)).toBe(0xfeff);
  });

  it("中文原样保留，不做任何转码", () => {
    const csv = toCsv(["院校"], [["北京大学"]]);
    expect(csv).toContain("北京大学");
  });
});

describe("转义", () => {
  it("字段里的逗号不该把一行拆成两列", () => {
    expect(csvCell("北京大学,计算机系")).toBe('"北京大学,计算机系"');
  });

  it("字段里的双引号要写成两个", () => {
    expect(csvCell('他说"再考虑一下"')).toBe('"他说""再考虑一下"""');
  });

  it("字段里的换行不该把一行拆成两行", () => {
    const csv = toCsv(["备注"], [["第一行\n第二行"]]);
    // 只有表头与数据两行，字段里的换行被引号包着不算行分隔
    expect(csv.replace(BOM, "").split("\r\n")).toHaveLength(2);
    expect(csv).toContain('"第一行\n第二行"');
  });

  it("空值统一导成空字符串，不导出 null / undefined 字样", () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell("")).toBe('""');
  });

  it("数字原样导出，不加千分位（加了 Excel 反而读不成数字）", () => {
    expect(csvCell(19800)).toBe('"19800"');
  });
});

describe("公式注入", () => {
  /**
   * 备注、姓名这些字段是用户自由输入的。Excel 和 Google Sheets 会把
   * 以 = + - @ 开头的单元格当公式执行，对账的人一打开就中招。
   */
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "=HYPERLINK(\"http://x\",\"点我\")"])(
    "以危险字符开头的 %s 要被前缀成纯文本",
    (输入) => {
      const 结果 = csvCell(输入);
      expect(结果.startsWith("\"'")).toBe(true);
      expect(结果).toContain(输入.replace(/"/g, '""'));
    },
  );

  it("制表符与回车开头同样要挡（某些版本的 Excel 会跳过它们再解析公式）", () => {
    expect(csvCell("\t=1+1").startsWith("\"'")).toBe(true);
    expect(csvCell("\r=1+1").startsWith("\"'")).toBe(true);
  });

  it("正常内容不加前缀，别把好数据改坏了", () => {
    expect(csvCell("张三")).toBe('"张三"');
    expect(csvCell("13800001111")).toBe('"13800001111"');
    expect(csvCell("A=B 这种中间带等号的不算")).toBe('"A=B 这种中间带等号的不算"');
  });

  it("表头本身也要走同一套转义", () => {
    const csv = toCsv(["=注入的表头"], [["正常"]]);
    expect(csv).toContain("\"'=注入的表头\"");
  });
});

describe("整体形态", () => {
  it("行数 = 表头 1 行 + 数据行数", () => {
    const rows = [["a", 1], ["b", 2], ["c", 3]];
    const csv = toCsv(["名称", "数量"], rows);
    expect(csv.replace(BOM, "").split("\r\n")).toHaveLength(4);
  });

  it("每行的列数与表头一致", () => {
    const csv = toCsv(["一", "二", "三"], [["1", "2", "3"]]);
    for (const line of csv.replace(BOM, "").split("\r\n")) {
      expect(line.match(/","/g)?.length ?? 0).toBe(2); // 三列之间有两个分隔
    }
  });
});
