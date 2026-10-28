/**
 * 设置 → 团队 · 价格块（D-03，2026-10-28）：登录了但云端没答上来（超时、断网、5xx），价格块留着说一句「暂时连不上」，
 * 不整块消失让上面「价格见下方」指向空处；没登录照旧不摆。
 *
 * 不引 jsdom：renderToStaticMarkup + createElement（同 ai-meter-bar.test.ts）。
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TeamPricing from "@/app/(app)/settings/TeamPricing";

describe("团队版价格块：云端失败时", () => {
  it("登录了、价格拿不到：块还在，说暂时连不上、照样能找我们开通", () => {
    const html = renderToStaticMarkup(createElement(TeamPricing, { 价格: null, 能用: true }));
    expect(html).toContain('data-testid="team-pricing"');
    expect(html).toContain("暂时连不上云端");
    expect(html).toContain("反馈");
  });

  it("没登录：不摆", () => {
    expect(renderToStaticMarkup(createElement(TeamPricing, { 价格: null, 能用: false }))).toBe("");
    expect(renderToStaticMarkup(createElement(TeamPricing, { 价格: undefined }))).toBe("");
  });

  it("拿到了：照常列价格，不出现「连不上」", () => {
    const html = renderToStaticMarkup(createElement(TeamPricing, { 价格: { trialDays: 7, prices: [{ months: 1, label: "1 个月", perSeat: 99, perMonth: 99 }] }, 能用: true }));
    expect(html).toContain("¥99");
    expect(html).not.toContain("连不上");
  });
});
