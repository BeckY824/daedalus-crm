/**
 * 设置 → 团队 · 团队版免费（2026-10-28 不标价）：不摆价格、不读价格表，不管连没连上云端都一样；
 * 价格接口回空表，0.46.29 及以前的桌面端拿到空表也就不摆价格。
 *
 * 不引 jsdom：renderToStaticMarkup + createElement（同 ai-meter-bar.test.ts）。
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TeamPricing from "@/app/(app)/settings/TeamPricing";

vi.mock("@/lib/tenant/sync-auth", () => ({ 认同步: async () => ({ ok: true }) }));

describe("团队版不标价", () => {
  it("设置页只说免费、怎么开通，不出现价格", () => {
    const html = renderToStaticMarkup(createElement(TeamPricing));
    expect(html).toContain('data-testid="team-pricing"');
    expect(html).toContain("团队版免费");
    expect(html).toContain("反馈");
    expect(html).not.toMatch(/¥|￥|\/ 人|试用|续费/);
  });

  it("价格接口回空表：旧版桌面端拿到就不摆价格块", async () => {
    const { GET } = await import("@/app/api/sync/pricing/route");
    const j = await (await GET(new Request("http://x/api/sync/pricing"))).json();
    expect(j).toEqual({ ok: true, prices: [], trialDays: 0 });
  });
});
