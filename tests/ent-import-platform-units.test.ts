/**
 * 企业版导入 · 平台导出的几种形状（不碰库）：
 * - 一个 xlsx 几张表（多维表格整份导出）：每张各认各的，隐藏的、空的不读；
 * - 客户表里带联系人几列（客户管理导出）：拆出一张联系人表，客户一行只留一行；
 * - 一格写了几个负责人：按第一个人认，报告里提醒；
 * - 对照表读回：填错的行列进问题、其余照改，「原系统 ID」读得回来。
 * 列名、阶段叫法都是测试里自己造的，代码里不写死任何一家的。
 */
import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { 拆人格, 拆联系人, 读文件们, type 读出的表 } from "@/lib/enterprise-import/excel";
import { 拆多人, 规则对负责人, 进备注, type 成员 } from "@/lib/enterprise-import/mapping";
import { 清洗 } from "@/lib/enterprise-import/clean";
import { 导出对照表, 读回对照表, 对照表头 } from "@/lib/enterprise-import/template";
import type { 试跑报告 } from "@/lib/enterprise-import/report";
import type { 原始记录, 映射 } from "@/lib/enterprise-import/types";

/* ───────────── 造 xlsx：几张表，可隐藏 ───────────── */

function 转义(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function 列字母(i: number) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
function 造xlsx(表们: { 名: string; 行: string[][]; 隐藏?: boolean }[]): Uint8Array {
  const 文件: Record<string, Uint8Array> = {};
  const sheets = 表们
    .map((t, i) => `<sheet name="${转义(t.名)}" sheetId="${i + 1}" r:id="rId${i + 1}"${t.隐藏 ? ' state="hidden"' : ""}/>`)
    .join("");
  文件["xl/workbook.xml"] = strToU8(
    `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`,
  );
  文件["xl/_rels/workbook.xml.rels"] = strToU8(
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${表们
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join("")}</Relationships>`,
  );
  表们.forEach((t, i) => {
    const rows = t.行
      .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${列字母(ci)}${ri + 1}" t="inlineStr"><is><t>${转义(v)}</t></is></c>`).join("")}</row>`)
      .join("");
    文件[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`);
  });
  return zipSync(文件);
}

function 表(名: string, 实体: 读出的表["实体"], 表头: string[], 行: string[][]): 读出的表 {
  return { 名, 实体, 表头, 行, 行号: 行.map((_, i) => i + 2), 提醒: [] };
}

describe("一个 xlsx 几张表", () => {
  const bytes = 造xlsx([
    { 名: "客户", 行: [["客户名称", "电话"], ["甲公司", "13800000001"], ["乙公司", "13800000002"]] },
    { 名: "旧数据", 隐藏: true, 行: [["客户名称"], ["不该读到"]] },
    { 名: "空表", 行: [] },
    { 名: "商机", 行: [["商机名称", "客户名称", "阶段"], ["一期", "甲公司", "方案"]] },
    { 名: "Sheet9", 行: [["跟进内容", "客户名称"], ["打了电话", "乙公司"]] },
  ]);

  it("每张叫「文件名·表名」，类别先看表名、再看表头；隐藏的、空的不读", () => {
    const 表们 = 读文件们({ 名: "整份导出.xlsx", bytes });
    expect(表们.map((t) => [t.名, t.实体, t.行.length])).toEqual([
      ["整份导出.xlsx·客户", "customer", 2],
      ["整份导出.xlsx·商机", "opportunity", 1],
      ["整份导出.xlsx·Sheet9", "followup", 1],
    ]);
    expect(JSON.stringify(表们)).not.toContain("不该读到");
  });

  it("多表时人在上传时指的类别不套到每一张上（各认各的）", () => {
    const 表们 = 读文件们({ 名: "整份导出.xlsx", bytes, 实体: "lead" });
    expect(表们.map((t) => t.实体)).toEqual(["customer", "opportunity", "followup"]);
  });

  it("只有一张表的 xlsx：名字就是文件名，人指的类别照用", () => {
    const one = 造xlsx([{ 名: "Sheet1", 行: [["名称"], ["甲"]] }]);
    const [t] = 读文件们({ 名: "随便.xlsx", bytes: one, 实体: "lead" });
    expect([t.名, t.实体]).toEqual(["随便.xlsx", "lead"]);
  });

  it("表都是空的（或都隐藏）：说清楚，不返回空数组", () => {
    const 空 = 造xlsx([{ 名: "a", 行: [] }, { 名: "b", 隐藏: true, 行: [["x"], ["y"]] }]);
    expect(() => 读文件们({ 名: "空.xlsx", bytes: 空 })).toThrow(/空的/);
  });
});

describe("客户表里带联系人：拆成两张", () => {
  const 原 = () =>
    表("客户.xlsx", "customer", ["客户编号", "客户名称", "联系人数", "联系人姓名", "联系人手机", "联系人职务", "客户等级"], [
      ["K1", "甲公司", "2", "张三", "13800000001", "经理", "A"],
      ["K1", "甲公司", "2", "李四", "13800000002", "采购", "A"],
      ["K1", "甲公司", "2", "李四", "13800000002", "采购", "A"], // 导出重复了一模一样的一行
      ["K2", "乙公司", "0", "", "", "", "B"],
      ["K3", "丙公司", "1", "王五", "", "", "C"],
    ]);

  it("联系人几列拆出去，带客户编号和名称挂回；「联系人数」是客户自己的，留在客户表", () => {
    const [客户, 联系人] = 拆联系人(原());
    expect(客户.表头).toEqual(["客户编号", "客户名称", "联系人数", "客户等级"]);
    expect(客户.行).toEqual([
      ["K1", "甲公司", "2", "A"],
      ["K2", "乙公司", "0", "B"],
      ["K3", "丙公司", "1", "C"],
    ]);
    expect(客户.行号).toEqual([2, 5, 6]);
    expect(联系人.名).toBe("客户.xlsx（联系人）");
    expect(联系人.实体).toBe("contact");
    expect(联系人.表头).toEqual(["所属客户ID", "所属客户", "姓名", "手机", "职务"]);
    expect(联系人.行).toEqual([
      ["K1", "甲公司", "张三", "13800000001", "经理"],
      ["K1", "甲公司", "李四", "13800000002", "采购"],
      ["K3", "丙公司", "王五", "", ""],
    ]);
    expect(联系人.行号).toEqual([2, 3, 6]);
    expect(客户.提醒.join("\n")).toMatch(/已拆成「客户\.xlsx（联系人）」/);
    expect(客户.提醒.join("\n")).toMatch(/重复出现了 2 行/);
  });

  it("没有客户编号列：联系人只按客户名称挂", () => {
    const t = 表("客户.csv", "customer", ["客户名称", "联系人", "联系人电话"], [["甲公司", "张三", "1"]]);
    const [, 联系人] = 拆联系人(t);
    expect(联系人.表头).toEqual(["所属客户", "姓名", "电话"]);
    expect(联系人.行).toEqual([["甲公司", "张三", "1"]]);
  });

  it("不拆的几种：不是客户表、没有联系人名字那一列、没有客户名称列、联系人几列全空", () => {
    const 商机 = 表("商机.csv", "opportunity", ["客户名称", "联系人姓名"], [["甲", "张三"]]);
    expect(拆联系人(商机)).toEqual([商机]);
    const 只有电话 = 表("客户.csv", "customer", ["客户名称", "联系人电话"], [["甲", "1"]]);
    expect(拆联系人(只有电话)).toEqual([只有电话]);
    const 没客户名 = 表("客户.csv", "customer", ["备注", "联系人姓名"], [["x", "张三"]]);
    expect(拆联系人(没客户名)).toEqual([没客户名]);
    const 全空 = 拆联系人(表("客户.csv", "customer", ["客户名称", "联系人姓名"], [["甲", ""]]));
    expect(全空).toHaveLength(1);
    expect(全空[0].表头).toEqual(["客户名称"]);
  });

  it("读文件们只读、只猜类别，不拆；拆是类别定了之后的事（试跑里拆）", () => {
    const csv = "﻿客户名称,联系人姓名,联系人手机\r\n甲公司,张三,13800000001\r\n";
    const 表们 = 读文件们({ 名: "客户.csv", bytes: strToU8(csv) });
    expect(表们.map((t) => [t.名, t.实体])).toEqual([["客户.csv", "customer"]]);
    expect(表们.flatMap(拆联系人).map((t) => [t.名, t.实体, t.拆自 ?? null])).toEqual([
      ["客户.csv", "customer", null],
      ["客户.csv（联系人）", "contact", "客户.csv"],
    ]);
  });

  it("拆人格：分人只按；;、换行，名字旁的电话 / 邮箱 / 标签取出来，只有号码的一段算前一个人", () => {
    expect(拆人格("张三")).toEqual([{ 名: "张三", 电话: [], 邮箱: [] }]);
    expect(拆人格("张三 138-0000-0001")).toEqual([{ 名: "张三", 电话: ["13800000001"], 邮箱: [] }]);
    expect(拆人格("李四（手机：13900000002）；王五 wangwu@x.com")).toEqual([
      { 名: "李四", 电话: ["13900000002"], 邮箱: [] },
      { 名: "王五", 电话: [], 邮箱: ["wangwu@x.com"] },
    ]);
    expect(拆人格("赵六；021-12345678")).toEqual([{ 名: "赵六", 电话: ["02112345678"], 邮箱: [] }]);
    // 逗号、斜杠不分：英文名、带分隔的名字照留
    expect(拆人格("Smith, John")).toEqual([{ 名: "Smith, John", 电话: [], 邮箱: [] }]);
    // 位数不够的不算电话（工号、分机）
    expect(拆人格("孙七 8023")).toEqual([{ 名: "孙七 8023", 电话: [], 邮箱: [] }]);
  });

  it("名字格里分出来的电话落到已有的联系人电话列（空着才填），撞了的进备注，不丢", () => {
    const t: 读出的表 = {
      名: "客户",
      实体: "customer",
      表头: ["客户名称", "联系人", "联系人手机", "联系人职位"],
      行: [
        ["甲公司", "张三 13800000001", "", "经理"],
        ["乙公司", "李四 13900000002", "13900000009", ""],
        ["丙公司", "王五、钱八", "", "采购"],
      ],
      行号: [2, 3, 4],
      提醒: [],
    };
    const [, 人] = 拆联系人(t);
    expect(人.表头).toEqual(["所属客户", "姓名", "手机", "职位", "备注"]);
    expect(人.行).toEqual([
      ["甲公司", "张三", "13800000001", "经理", ""],
      ["乙公司", "李四", "13900000009", "", "另有：13900000002"],
      ["丙公司", "王五", "", "采购", ""],
      ["丙公司", "钱八", "", "", ""],
    ]);
    expect(人.行号).toEqual([2, 3, 4, 4]);
    expect(人.提醒.join("")).toMatch(/3 格/);
  });
});

describe("一格几个负责人", () => {
  const 成员们: 成员[] = [
    { id: "u-a", name: "甲一", email: "a@x.invalid" },
    { id: "u-b", name: "乙二", email: "b@x.invalid" },
  ];

  it("拆多人：逗号、顿号、分号、斜杠都算；一个人返回空", () => {
    expect(拆多人("甲一,乙二")).toEqual(["甲一", "乙二"]);
    expect(拆多人("甲一、 乙二；丙三")).toEqual(["甲一", "乙二", "丙三"]);
    expect(拆多人("甲一 / 乙二")).toEqual(["甲一", "乙二"]);
    expect(拆多人("甲一")).toEqual([]);
  });

  it("规则对负责人：整格认不出按第一个人认；第一个人认不出不往后挑", () => {
    expect(规则对负责人("甲一,乙二", 成员们)).toBe("u-a");
    expect(规则对负责人("b@x.invalid，甲一", 成员们)).toBe("u-b");
    expect(规则对负责人("不认识,乙二", 成员们)).toBe("");
  });

  it("清洗：对上了的几人一格照写到映射那人名下，另提醒「负责人有几个」；一个人的不提醒", () => {
    const m: 映射 = {
      列: { customer: { 名称: "name", 负责人: "owner", 杂: 进备注 } },
      负责人: { "甲一,乙二": "u-a", 乙二: "u-b" },
      值: { 阶段: {}, 线索状态: {}, 跟进类型: {}, 跟进状态: {} },
      默认负责人Id: "u-default",
    };
    const 条 = (外部ID: string, 名称: string, 负责人: string): 原始记录 => ({ 实体: "customer", 外部ID, 字段: { 名称, 负责人 }, 行号: 2 });
    const { 待写, 问题 } = 清洗([条("1", "甲公司", "甲一,乙二"), 条("2", "乙公司", "乙二")], m);
    expect(待写.map((w) => w.值.salesOwnerId)).toEqual(["u-a", "u-b"]);
    expect(问题.map((p) => [p.外部ID, p.级别, p.类别])).toEqual([["1", "提醒", "负责人有几个"]]);
    expect(问题[0].说明).toMatch(/写了 2 个人/);
  });
});

/* ───────────── 对照表 ───────────── */

describe("对照表：导出 → 填 → 读回", () => {
  const 成员们: 成员[] = [
    { id: "u-a", name: "甲一", email: "a@x.invalid" },
    { id: "u-b1", name: "同名", email: "b1@x.invalid" },
    { id: "u-b2", name: "同名", email: null },
  ];

  const 报告 = {
    映射: {
      列: {
        customer: [
          { 表头: "编号", 字段: "id", 字段名: "原系统 ID", 样例: [] },
          { 表头: "公司", 字段: "name", 字段名: "名称", 样例: [] },
          { 表头: "说明", 字段: 进备注, 字段名: "拼进备注", 样例: [] },
          { 表头: "系统列", 字段: "", 字段名: "不用", 样例: [] },
        ],
        followup: [{ 表头: "记录", 字段: "content", 字段名: "内容", 样例: [] }],
      },
      值: [
        { 名: "阶段", 叫法: "商机阶段", 原值: "阶段甲", 我们的值: "" },
        { 名: "跟进类型", 叫法: "跟进方式", 原值: "打电话", 我们的值: "PHONE" },
      ],
      负责人: [
        { 写法: "老甲", 成员Id: "", 成员名: "" },
        { 写法: "老乙", 成员Id: "u-b1", 成员名: "同名" },
      ],
      默认负责人: { id: "u-a", 名: "甲一" },
    },
  } as unknown as 试跑报告;

  const 读 = (csv: string) => 读回对照表({ 名: "对照表.csv", bytes: strToU8(csv) }, 报告, 成员们);
  const 行们 = () => 导出对照表(报告, 成员们).replace(/^﻿/, "").trim().split("\r\n");

  it("导出：表头固定，每项一行；重名成员写邮箱，跟进的备注叫「拼进内容」", () => {
    const 行 = 行们();
    expect(行[0]).toBe(对照表头.join(","));
    expect(行).toContain(`列,客户,编号,原系统 ID,${行[1].split(",").slice(4).join(",")}`);
    expect(行.find((r) => r.startsWith("列,跟进记录,记录,内容,"))).toMatch(/拼进内容/);
    expect(行).toContain("负责人,,老乙,b1@x.invalid,成员名字或邮箱（重名的填邮箱）；空着 = 默认负责人");
    expect(行.find((r) => r.startsWith("商机阶段,"))).toMatch(/^商机阶段,商机,阶段甲,,/);
    expect(行.at(-1)).toMatch(/^默认负责人,,,甲一,/);
  });

  it("原样传回：一项不改、没有问题（「原系统 ID」也认得回来）", () => {
    expect(读(行们().join("\r\n"))).toEqual({ 改: {}, 改了: 0, 问题: [] });
  });

  it("改对的照收：列、值（中文说法也认）、负责人（邮箱）、默认负责人", () => {
    const csv = [
      对照表头.join(","),
      "列,客户,说明,不用,",
      "列,客户,系统列,电话,",
      "商机阶段,商机,阶段甲,输单,",
      "跟进方式,跟进记录,打电话,上门拜访,",
      "负责人,,老甲,a@x.invalid,",
      "负责人,,老乙,,",
      "默认负责人,,,b1@x.invalid,",
    ].join("\r\n");
    const r = 读(csv);
    expect(r.问题).toEqual([]);
    expect(r.改了).toBe(7);
    expect(r.改).toEqual({
      列: { customer: { 说明: "", 系统列: "phone" } },
      值: { 阶段: { 阶段甲: "输单" }, 跟进类型: { 打电话: "VISIT" } },
      负责人: { 老甲: "u-a", 老乙: "" },
      默认负责人Id: "u-b1",
    });
  });

  it("填错的行列进问题、说清楚第几行，其余照改", () => {
    const csv = [
      对照表头.join(","),
      "列,客户,公司,不存在的字段,", // 第 2 行
      "列,不知道,公司,名称,", // 3
      "列,客户,改过的列名,名称,", // 4
      "商机阶段,商机,阶段甲,乱填的阶段,", // 5
      "商机阶段,商机,这次没有的阶段,输单,", // 6
      "负责人,,老甲,同名,", // 7：重名没邮箱
      "负责人,,老甲,nobody@x.invalid,", // 8
      "负责人,,改过的写法,甲一,", // 9
      "默认负责人,,,,", // 10
      "瞎写的类别,,x,y,", // 11
      ",,,,", // 空行不算
      "列,跟进记录,记录,拼进备注,", // 13：跟进写「拼进备注」也认（落到内容）
    ].join("\r\n");
    const r = 读(csv);
    expect(r.改).toEqual({ 列: { followup: { 记录: 进备注 } } });
    expect(r.改了).toBe(1);
    expect(r.问题).toHaveLength(10);
    const 第 = (n: number) => r.问题.find((p) => p.startsWith(`第 ${n} 行`)) ?? "";
    expect(第(2)).toMatch(/没有「不存在的字段」这个字段/);
    expect(第(3)).toMatch(/「哪一类」填的「不知道」认不出/);
    expect(第(4)).toMatch(/没有「改过的列名」这一列/);
    expect(第(5)).toMatch(/商机阶段没有「乱填的阶段」/);
    expect(第(6)).toMatch(/没有商机阶段「这次没有的阶段」/);
    expect(第(7)).toMatch(/2 个同名成员，请填邮箱/);
    expect(第(8)).toMatch(/找不到邮箱是「nobody@x\.invalid」/);
    expect(第(9)).toMatch(/没有负责人「改过的写法」/);
    expect(第(10)).toMatch(/默认负责人不能空着/);
    expect(第(11)).toMatch(/「类别」填的「瞎写的类别」认不出/);
  });

  it("表头不对：直接报错，让人用导出的那张", () => {
    expect(() => 读("a,b,c\r\n1,2,3")).toThrow(/表头不对/);
  });

  it("客户在 Excel 里另存成 xlsx 也读得回", () => {
    const rows = 行们().map((r) => r.split(","));
    rows.push(["负责人", "", "老甲", "甲一", ""]);
    const bytes = 造xlsx([{ 名: "Sheet1", 行: rows }]);
    const r = 读回对照表({ 名: "对照表.xlsx", bytes }, 报告, 成员们);
    expect(r.问题).toEqual([]);
    expect(r.改).toEqual({ 负责人: { 老甲: "u-a" } });
  });
});
