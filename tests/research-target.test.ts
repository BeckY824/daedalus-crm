/**
 * 背调模式里那一句话要查的是哪家（lib/research/target.ts）：认准了直接开跑；认不准先让人点选，不扣次数。
 */
import { describe, it, expect } from "vitest";
import { 认背调对象 } from "@/lib/research/target";

describe("认背调对象", () => {
  it.each([
    ["帮我查 Rexel 适不适合我们", "Rexel"],
    ["Rexel", "Rexel"],
    ["背调一下 Lumora Trading GmbH，看值不值得开发", "Lumora Trading GmbH"],
    ["查一下 Paulmann Licht 的背景", "Paulmann Licht"],
    ["Thorn Lighting 靠不靠谱", "Thorn Lighting"],
    ["深圳市某某照明有限公司怎么样", "深圳市某某照明有限公司"],
    // 给了官网 / 网址 / 邮箱：按域名查，最准
    ["rexel.com", "rexel.com"],
    ["帮我看看 https://www.deltalight.com/en 这家", "deltalight.com"],
    ["sales@rexel.com", "rexel.com"],
  ])("「%s」→ 直接查 %s", (原话, 公司) => {
    expect(认背调对象(原话)).toEqual({ 种类: "公司", 公司 });
  });

  it("一句里好几家：让人点一家", () => {
    expect(认背调对象("Rexel 和 Sonepar 哪家好")).toEqual({ 种类: "候选", 候选: ["Rexel", "Sonepar"] });
    expect(认背调对象("帮我查 Graybar、Wesco")).toEqual({ 种类: "候选", 候选: ["Graybar", "Wesco"] });
  });

  it("名字太短、同名多：可以直接查，也提醒补个国家或官网", () => {
    expect(认背调对象("SLV")).toMatchObject({ 种类: "要补充", 公司: "SLV" });
    expect(认背调对象("台达")).toMatchObject({ 种类: "要补充", 公司: "台达" });
  });

  it.each(["这家公司", "他们", "帮我查查", "   "])("认不出：「%s」", (原话) => {
    expect(认背调对象(原话)).toEqual({ 种类: "认不出" });
  });
});
