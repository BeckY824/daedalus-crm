/**
 * 小满式导出导进来（2026-10-06 测试分期 B.7）。
 *
 * 没有客户脱敏的真导出，样表照小满官方客户导入模板的 22 列表头原样拼（加导出常带的跟进人 / 创建时间 / 最近跟进时间），
 * 生成见 tests/fixtures/xiaoman-make.py。钉的是：外贸模版下这份表**不用人手动对列**就能导进能导的那几行，
 * 导不进的每一行都说得出原因，没对上的列一个字不丢（并进备注）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { 读xlsx带行号 } from "@/lib/import/xlsx";
import { 成表 } from "@/lib/import/parse";
import { 字段表, 猜列 } from "@/lib/import/fields";
import { 摊开, 并重复行 } from "@/lib/import/plan";
import { BUSINESS_PRESETS, 模版预设 } from "@/lib/business-config";

const 外贸 = BUSINESS_PRESETS[模版预设.trade];
const 表 = 字段表(外贸);
const { rows, 行号 } = 读xlsx带行号(new Uint8Array(readFileSync(path.join(__dirname, "fixtures", "小满式-客户导出.xlsx"))));
const 成 = 成表(rows, undefined, 行号);
const 映射 = 猜列(成.表头, 表);
const 对到 = (头: string) => 映射[成.表头.indexOf(头)];
const 行们 = 摊开({ 表头: 成.表头, 数据: 成.数据, 行号: 成.行号, 映射, 字段表: 表 });
const { 行: 合后 } = 并重复行(行们);
const 第 = (n: number) => 行们.find((r) => r.行号 === n)!;

describe("小满式导出（外贸模版）", () => {
  it("表头在第一行认出来，25 列都在", () => {
    expect(成.表头[0]).toBe("公司名称");
    expect(成.表头).toHaveLength(25);
    expect(成.数据).toHaveLength(7);
  });

  it("不用手动对列：联系人昵称 → 姓名、联系人电话 → 电话、联系人邮箱 → 邮箱、公司名称 → 公司、国家地区 / 客户来源 / 职位各归各位", () => {
    expect(对到("联系人昵称")).toBe("name");
    expect(对到("联系人电话")).toBe("phone");
    expect(对到("联系人邮箱")).toBe("email");
    expect(对到("公司名称")).toBe("school");
    expect(对到("国家地区")).toBe("country");
    expect(对到("客户来源")).toBe("source");
    expect(对到("职位")).toBe("grade");
    // 座机是公司总机：同一公司几位联系人共用一个，拿它认人会把几位合成一位——不对到电话
    expect(对到("座机")).toBeNull();
    // 跟进人不导（负责人是导入的人本人，fields.ts 开头那条），原话并进备注
    expect(对到("跟进人")).toBeNull();
  });

  it("有联系人电话的四行进得来，号码规整好、档案落对格", () => {
    const tim = 第(2);
    expect(tim.进不了).toBeUndefined();
    expect(tim.值).toMatchObject({ name: "Tim Cook", school: "Apple, Inc", email: "example@apple.com", country: "美国", source: "官网询盘", grade: "CEO" });
    expect(tim.值.phone?.replace(/\D/g, "")).toBe("18002752273");
    expect(第(4).值.phone?.replace(/\D/g, "")).toBe("14089961010");
    expect(第(5).值.phone?.replace(/\D/g, "")).toBe("971501234567");
    // Excel 存成数字的号码不变成科学计数法
    expect(第(8).值.phone?.replace(/\D/g, "")).toBe("2348031234567");
    for (const n of [2, 4, 5, 8]) expect(第(n).进不了, `第 ${n} 行`).toBeUndefined();
  });

  it("同一公司两位联系人是两位客户（号码不同不合并）", () => {
    expect(合后.filter((r) => !r.进不了 && r.值.school === "Apple, Inc")).toHaveLength(2);
  });

  it("进不来的每一行都说得出原因：模板说明行、只有邮箱的、只有座机的", () => {
    for (const n of [3, 6, 7]) expect(第(n).进不了, `第 ${n} 行`).toBeTruthy();
    expect(第(6).进不了).toMatch(/电话/);
    // 只有座机的那行：说法要提到座机，不能说「没有电话」——表里明明写着一个号码
    expect(第(7).进不了).toMatch(/座机/);
  });

  it("没对上的列一个字不丢：客户编号、阶段、跟进人、网址、领英、日期都并进备注；日期写成日期不是序列号", () => {
    const 备注 = 第(2).值.remark ?? "";
    for (const s of ["客户编号：11235", "客户阶段：待跟进", "跟进人：王小满", "公司网址：www.apple.com", "LinkedIn：https://www.linkedin.cn/company/apple/", "公司备注：蓝底为公司字段", "联系人备注：橙底为联系人字段", "座机：1-8667527753"]) {
      expect(备注).toContain(s);
    }
    expect(备注).toMatch(/创建时间：2026-03-02/);
    expect(备注).not.toMatch(/创建时间：\d{5}/);
    // 地址里的零宽字符不带进来
    expect(备注).not.toMatch(/​/);
  });
});
