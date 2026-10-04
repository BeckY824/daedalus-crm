/**
 * 左栏 AI 用量条（H-028）：分母原来是累计赠送（开户 30 + 之后补的），「还剩 30 / 330」只画 9%，
 * 新用户一进来就以为快用完了。现在按开户那 30 次画满格，多出来的也只是满格、不往外溢。
 *
 * 不引 jsdom：renderToStaticMarkup + createElement（同 markdown.test.ts）。
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AiMeterBar, AiMeterProvider } from "@/components/AiCost";
import type { AI计次 } from "@/lib/ai-meter";

const 渲 = (初值: AI计次) => renderToStaticMarkup(createElement(AiMeterProvider, { 初值 }, createElement(AiMeterBar)));
const 宽 = (html: string) => Number(/style="width:([\d.]+)%"/.exec(html)?.[1]);

describe("左栏 AI 用量条（H-028）", () => {
  it("还剩 30、累计上限 330：满格，不是 9%", () => {
    const html = 渲({ 计次: true, 还剩: 30, 上限: 330 });
    expect(宽(html)).toBe(100);
    expect(html).toContain("还剩 30 次");
    // 不写「/ 共几次」：分母自己涨，看着像算错了
    expect(html).not.toContain("330");
  });

  it("还剩 3：10%，并且标成「快用完」；还剩 0：空条、标成用完", () => {
    const 三 = 渲({ 计次: true, 还剩: 3, 上限: 330 });
    expect(宽(三)).toBe(10);
    const 二 = 渲({ 计次: true, 还剩: 2, 上限: 30 });
    expect(二).toContain("rail-meter low");
    const 零 = 渲({ 计次: true, 还剩: 0, 上限: 30 });
    expect(宽(零)).toBe(0);
    expect(零).toContain("rail-meter out");
  });

  it("当天补过、还剩比 30 多：也只是满格，不往外溢", () => {
    expect(宽(渲({ 计次: true, 还剩: 45, 上限: 60 }))).toBe(100);
  });

  it("不计次的人（自带 Key、自部署）、还没问到数：整条不画", () => {
    expect(渲({ 计次: false, 还剩: null, 上限: null })).toBe("");
    expect(渲({ 计次: true, 还剩: null, 上限: 30 })).toBe("");
  });
});
