/**
 * 手机伴侣头像字和国旗（2026-10-19 团队版主动排查）：
 * emoji 开头的名字头像显示「�」（slice 切出半个 emoji）、俄文公司名 ООО «…» 头像只剩「·」、填「阿拉伯联合酋长国」没有国旗
 */
import { describe, expect, it } from "vitest";
import { 简称, 国旗 } from "@/lib/mobile/view";

describe("手机头像字", () => {
  it.each([
    ["深圳市宝安区某某照明", "深"],
    ["Sunny 灯饰有限公司", "S"],
    ["灯饰 Sunny", "灯"],
    ["株式会社 トヨタ", "株"],
    ["Supercalifragilistic Lighting Co", "SL"],
    ["acme", "A"],
    ["3M China", "3C"],
    ["ООО «Светотехническая компания»", "ОС"],
    ["(Pty) Ltd Acme", "PL"],
    ["شركة النور للتجارة", "ش"],
    ["🌟Sunny 灯饰🌈✨有限公司😀", "S"],
    ["😀😀", "😀"],
    ["  ", "·"],
  ])("%s → %s", (名, 字) => {
    expect(简称(名)).toBe(字);
  });

  it("不会切出半个字符", () => {
    for (const 名 of ["🌟", "👨‍👩‍👧‍👦 家", "𠮷野家"]) expect(简称(名)).not.toMatch(/[\uD800-\uDFFF]/u);
  });
});

describe("手机国旗", () => {
  it("别名也认得", () => {
    expect(国旗("阿联酋")).toBe("🇦🇪");
    expect(国旗("阿拉伯联合酋长国")).toBe("🇦🇪");
    expect(国旗("UAE")).toBe("🇦🇪");
    expect(国旗(" 沙特 ")).toBe("🇸🇦");
  });
  it("客户档案的国家候选都有旗", async () => {
    const { 国家候选 } = await import("@/lib/customer-extra");
    const 缺 = 国家候选.flatMap((g) => g.国家).filter((c) => !国旗(c));
    expect(缺).toEqual([]);
  });
  it("认不得的不瞎猜", () => {
    expect(国旗("火星")).toBe("");
  });
});
