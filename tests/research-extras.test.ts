/**
 * 10-18 对比免费产品加的几块（lib/research/extras.ts）：风险必查四项、在卖型号、联系人、型号对比、英文开发信。
 * 钉的是「模型编的不收」：型号名、联系人的姓名电话邮箱要在来源原文里出现过；必查查不到不带来源；私人社交页上的联系人不收。
 */
import { describe, it, expect } from "vitest";
import { 原文里有, 号码在原文, 认必查, 认型号, 认联系人, 认型号对比, 认开发信, 必查转风险, type 找材料 } from "@/lib/research/extras";

const 官网 = "https://lumora.example/about";
const 页: Record<string, string> = {
  [官网]: "Range includes the HB-150 high-bay and the SL-60 street light. Head of Purchasing: Jan Beispiel. Contact: sales@lumora.example, +49 40 1234 5678.",
  "https://www.instagram.com/jan.beispiel": "Jan Beispiel +49 170 1111111 holiday photos",
  "https://registry.example/lumora": "Lumora Trading GmbH, Hamburg. Registered 2009.",
};
const 找: 找材料 = (u) => (typeof u === "string" && 页[u] ? { url: u, text: 页[u] } : typeof u === "number" && u === 1 ? { url: 官网, text: 页[官网] } : undefined);

describe("原文比对", () => {
  it("型号忽略大小写、空格、连字符；太短的不算", () => {
    expect(原文里有(页[官网], "HB-150")).toBe(true);
    expect(原文里有(页[官网], "hb 150")).toBe(true);
    expect(原文里有(页[官网], "HB-200")).toBe(false);
    expect(原文里有(页[官网], "H")).toBe(false);
  });
  it("电话按位数比：写没写国家码、带不带 0 都认；别的号不认", () => {
    expect(号码在原文(页[官网], "+49 40 1234 5678")).toBe(true);
    expect(号码在原文(页[官网], "040 1234 5678")).toBe(true);
    expect(号码在原文(页[官网], "0049 40 12345678")).toBe(true);
    expect(号码在原文(页[官网], "+49 40 9999 5678")).toBe(false);
    expect(号码在原文(页[官网], "5678")).toBe(false);
  });
});

describe("必查四项", () => {
  it("固定四行固定顺序；漏了的、来源核不上的、说「查不到」的都是查不到、不带来源", () => {
    const r = 认必查(
      {
        母公司: { 结论: "独立公司", 级别: "none", 来源: "https://registry.example/lumora" },
        财务: { 结论: "2024 年亏损", 级别: "mid", 来源: "https://made-up.example/x" },
        同行: { 结论: "查不到" },
      },
      找,
    );
    expect(r.map((x) => x.key)).toEqual(["母公司", "财务", "同行", "市场"]);
    expect(r[0]).toEqual({ key: "母公司", 结论: "独立公司", 级别: "none", source: "https://registry.example/lumora" });
    expect(r[1]).toEqual({ key: "财务", 结论: "查不到（材料里没有）", 级别: "none" });
    expect(r[2]).toEqual({ key: "同行", 结论: "查不到（材料里没有）", 级别: "none", 是: "查不到" });
    expect(r[3].source).toBeUndefined();
    expect(认必查(undefined, 找)).toHaveLength(4);
  });
  it("同行：有来源才信「是 / 部分 / 否」；写错的当查不到。有级别的转成风险，none 的不转", () => {
    const r = 认必查({ 同行: { 结论: "母公司有自己的工厂，也生产灯具", 是: "部分", 级别: "mid", 来源: 1 }, 市场: { 结论: "在德国", 是: "是", 级别: "超高", 来源: 官网 } }, 找);
    expect(r[2]).toMatchObject({ 是: "部分", 级别: "mid", source: 官网 });
    expect(r[3]).toMatchObject({ 级别: "none" });
    expect(r[3].是).toBeUndefined();
    expect(认必查({ 同行: { 结论: "像是同行", 是: "大概", 来源: 官网 } }, 找)[2].是).toBe("查不到");
    expect(必查转风险(r)).toEqual([{ 级别: "mid", 说明: "是不是同行：母公司有自己的工厂，也生产灯具", 来源: 官网 }]);
  });
});

describe("在卖型号、联系人", () => {
  it("型号名必须在来源原文里；最多 3 个、重复的去掉", () => {
    const r = 认型号(
      [
        { 型号: "HB-150", 是什么: "工矿灯", 来源: 官网 },
        { 型号: "hb 150", 来源: 官网 },
        { 型号: "ZZ-999", 来源: 官网 },
        { 型号: "SL-60", 来源: "https://made-up.example" },
        { 型号: "SL-60", 来源: 1 },
      ],
      找,
    );
    expect(r).toEqual([
      { 型号: "HB-150", 是什么: "工矿灯", source: 官网 },
      { 型号: "SL-60", source: 官网 },
    ]);
    expect(认型号("不是数组", 找)).toEqual([]);
  });
  it("联系人：姓名 / 电话 / 邮箱各自核，没出现的格子去掉；一格都不剩的整条不要；私人社交页不收", () => {
    const r = 认联系人(
      [
        { 岗位: "采购负责人", 姓名: "Jan Beispiel", 电话: "+49 40 1234 5678", 邮箱: "jan@lumora.example", 来源: 官网 },
        { 岗位: "总经理", 姓名: "Max Erfunden", 来源: 官网 },
        { 岗位: "销售", 邮箱: "sales@lumora.example", 来源: 官网 },
        { 岗位: "本人", 姓名: "Jan Beispiel", 电话: "+49 170 1111111", 来源: "https://www.instagram.com/jan.beispiel" },
      ],
      找,
    );
    expect(r).toEqual([
      { 岗位: "采购负责人", 姓名: "Jan Beispiel", 电话: "+49 40 1234 5678", source: 官网 },
      { 岗位: "销售", 邮箱: "sales@lumora.example", source: 官网 },
    ]);
  });
});

describe("型号对比、开发信", () => {
  const 型号们 = [{ 型号: "HB-150", source: 官网 }];
  it("对方那一格必须是认出来的型号；我们 / 怎么比不能空", () => {
    expect(
      认型号对比(
        [
          { 对方: "HB-150 工矿灯", 我们: "UFO 150W", 怎么比: "同功率，我们有 ENEC 版" },
          { 对方: "XX-1", 我们: "随便", 怎么比: "认不出" },
          { 对方: "HB-150", 我们: "", 怎么比: "空" },
        ],
        型号们,
      ),
    ).toEqual([{ 对方: "HB-150", 我们: "UFO 150W", 怎么比: "同功率，我们有 ENEC 版" }]);
    expect(认型号对比([{ 对方: "HB-150", 我们: "x", 怎么比: "y" }], [])).toEqual([]);
  });
  it("开发信要英文、60–320 词；写成中文或太短的不给", () => {
    const 词 = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
    expect(认开发信({ 主题: "LED high-bays", 正文: 词(150) })).toEqual({ 主题: "LED high-bays", 正文: 词(150) });
    expect(认开发信({ 主题: "LED high-bays", 正文: 词(30) })).toBeUndefined();
    expect(认开发信({ 主题: "LED high-bays", 正文: 词(400) })).toBeUndefined();
    expect(认开发信({ 主题: "您好", 正文: `${词(100)} 我们是一家照明工厂` })).toBeUndefined();
    expect(认开发信({ 主题: "", 正文: 词(100) })).toBeUndefined();
    expect(认开发信("x")).toBeUndefined();
  });
});
