/**
 * 第三轮对抗复查 · 导入解析（4e573c1）
 *
 * 两处新逻辑叠在一起出事：
 *   - xlsx 合并单元格「把左上的值填满整个合并区」
 *   - 成表「前 5 行里第一个填了的格子 ≥ 最宽一半的当表头」
 * 大标题横着合并（A1:D1）是最常见的表头在第二行的样子；合并填满以后标题行有 4 格，被认成表头。
 * 已有的 r2-data「表头在第二行」用例只看了 13800000001 在不在数据里，没看表头是哪一行，所以没抓到。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { 解析CSV, 成表 } from "@/lib/import/parse";
import { 读xlsx } from "@/lib/import/xlsx";
import { 字段表, 猜列 } from "@/lib/import/fields";
import { 摊开 } from "@/lib/import/plan";
import { DEFAULT_BUSINESS } from "@/lib/business-config";

const 夹具 = (名: string) => new Uint8Array(readFileSync(path.join(__dirname, "fixtures", 名)));

describe("表头在第二行 × 合并单元格填满", () => {
  it("第一行是横着合并的大标题（A1:D1）：表头该是第二行「姓名 / 手机号 / 公司 / 备注」，手机号列认得出", () => {
    const t = 成表(读xlsx(夹具("r2-data-表头第二行.xlsx")));
    expect(t.表头).toEqual(["姓名", "手机号", "公司", "备注"]);
    // 认错表头的后果：「姓名 / 手机号 …」那一行成了第一个「客户」，列也猜不出来
    expect(猜列(t.表头, 字段表(DEFAULT_BUSINESS))).toContain("phone");
    expect(t.数据[0][0]).toBe("张三");
  });
});

describe("成表认表头：表头比数据窄", () => {
  it("表头只写了 2 列、数据每行 5 格（后面几列没起名）：第一位客户被当成表头吃掉", () => {
    const t = 成表(解析CSV("姓名,手机号,,,\n张三,13800000001,北京,男,老客户\n李四,13800000002,上海,女,新客户"));
    expect(t.表头.slice(0, 2)).toEqual(["姓名", "手机号"]);
    expect(t.数据.map((r) => r[0])).toEqual(["张三", "李四"]);
  });
});

/*
  2026-10-04 回归核对 J-056：两处解析上的丢字。
  ① 列数取最宽的数据行，但表头没补齐——表头只写 2 列、数据 5 格时，后 3 列连映射都没有，原文一个字不进备注
  ② 「张三, "北京, 海淀"」逗号后带一个空格再开引号（手写、别的系统导出的常见样子），引号被当普通字符，一格拆成两格
*/
describe("J-056 表头比数据窄 / 逗号后带空格的引号字段", () => {
  it("表头 2 列、数据每行 5 格 → 表头补齐到 5 列，后 3 列的原文并进备注（写成「第 N 列：值」）", () => {
    const 表 = 字段表(DEFAULT_BUSINESS);
    const t = 成表(解析CSV("姓名,手机号\n张三,13800000001,北京,男,老客户"));
    expect(t.表头).toHaveLength(5);
    const [行] = 摊开({ 表头: t.表头, 数据: t.数据, 映射: 猜列(t.表头, 表), 字段表: 表 });
    expect(行.值.remark).toBe("第 3 列：北京\n第 4 列：男\n第 5 列：老客户");
  });

  it("表头那几格写成空的（「姓名,手机号,,,」）也一样：有值的格子并进备注，不悄悄丢", () => {
    const 表 = 字段表(DEFAULT_BUSINESS);
    const t = 成表(解析CSV("姓名,手机号,,,\n张三,13800000001,北京,,老客户"));
    const [行] = 摊开({ 表头: t.表头, 数据: t.数据, 映射: 猜列(t.表头, 表), 字段表: 表 });
    expect(行.值.remark).toBe("第 3 列：北京\n第 5 列：老客户");
  });

  it("解析CSV('张三, \"北京, 海淀\"') → 两格：「张三」「北京, 海淀」", () => {
    expect(解析CSV('张三, "北京, 海淀"')).toEqual([["张三", "北京, 海淀"]]);
  });
});
