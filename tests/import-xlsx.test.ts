/**
 * 读 xlsx。
 *
 * 用的是 openpyxl 真写出来的文件（tests/fixtures/*.xlsx），不是我们自己拼的 zip——
 * 自己写自己读的测试只能证明两段代码对同一个误解是一致的。
 * 重新生成：见 scripts/make-xlsx-fixtures.py。
 *
 * 钉的是四件「错了不报错、只是结果不对」的事：
 *   1. 空格子在 XML 里直接不出现 → 不按 r 属性补位的话整行往左错位，
 *      于是备注列的内容进了公司列，一个字的报错都没有
 *   2. 第一张标签页对应的文件**不一定叫 sheet1.xml**（删过表的簿子里就不是）
 *   3. 手机号被 Excel 存成数字时不能变成科学计数法
 *   4. 日期不在这一层认——原样交出去，由 plan.ts 统一认，否则两处两种结果
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { 读xlsx, 读不出来 } from "@/lib/import/xlsx";
import { 成表 } from "@/lib/import/parse";

const 读 = (名: string) => 读xlsx(new Uint8Array(readFileSync(path.join(__dirname, "fixtures", 名))));

describe("读 xlsx", () => {
  it("表头和数据都读得出来，中文不乱码", () => {
    const rows = 读("名单.xlsx");
    expect(rows[0]).toEqual(["姓名", "手机号", "公司", "预计签约", "备注"]);
    expect(rows[1][0]).toBe("张三");
    expect(rows[1][2]).toBe("星辰科技");
  });

  it("中间空着的格子要补位——不补的话后面的列整体往左错一格", () => {
    const rows = 读("名单.xlsx");
    const 李四 = rows.find((r) => r[0] === "李四")!;
    expect(李四[1]).toContain("13800000002");
    expect(李四[2] ?? "").toBe("");
  });

  it("被 Excel 存成数字的手机号不能变成科学计数法", () => {
    const 李四 = 读("名单.xlsx").find((r) => r[0] === "李四")!;
    expect(李四[1]).not.toContain("E+");
    expect(李四[1].replace(/\D/g, "")).toBe("13800000002");
  });

  it("引号这类要转义的字符读回来是原文", () => {
    const 王五 = 读("名单.xlsx").find((r) => r[0] === "王五")!;
    expect(王五[4]).toBe('他说"再看看"');
  });

  it("整行空的丢掉", () => {
    expect(读("名单.xlsx").every((r) => r.some((c) => c.trim() !== ""))).toBe(true);
  });

  it("日期原样交出去，不在这一层认——认日期只有 plan.ts 那一处", () => {
    const 张三 = 读("名单.xlsx").find((r) => r[0] === "张三")!;
    // Excel 存的是序列号；就算哪天存的是别的写法，这一层也不该把它变成 Date
    expect(typeof 张三[3]).toBe("string");
  });

  it("第一张标签页对应的文件不叫 sheet1.xml 时也要找得到", () => {
    // 删过工作表的簿子里就是这样。写死 sheet1.xml 的话这里读到的是空表
    const rows = 读("删过表.xlsx");
    expect(rows[0]).toEqual(["姓名", "手机号"]);
    expect(rows[1][0]).toBe("赵六");
  });

  it("不是 zip 的文件要给一句人话，并且指一条路", () => {
    // .xls（2003 年那种）是 OLE 复合文档，不是 zip，用户完全分不出这两个后缀
    try {
      读xlsx(new Uint8Array([1, 2, 3, 4, 5]));
      throw new Error("本该抛");
    } catch (e) {
      expect(e).toBeInstanceOf(读不出来);
      expect((e as Error).message).toContain("另存为");
    }
  });

  it("出来的形状和 CSV 那条路一模一样，能直接喂给 成表", () => {
    // 这是整条管线只有一套的根据
    const { 表头, 数据 } = 成表(读("名单.xlsx"));
    expect(表头).toHaveLength(5);
    expect(数据.every((r) => r.length === 5)).toBe(true);
  });
});
