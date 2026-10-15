/**
 * 新电脑连上团队的那一块（ConnectPanel，2026-10-15）：首页自动弹的框和「设置 → 团队」那张卡共用。
 * 已经在等就直接显示同一组数字（不再发）；本机有客户时说清楚会带进团队、先备份；老板那句「手机批的管不了团队」；框底部的「以后再说」。
 * 不引 jsdom：renderToStaticMarkup（同 ai-meter-bar.test.ts）。服务端动作换成假的，渲染时不该被调用。
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const 调用 = vi.hoisted(() => ({ 发起: 0, 查: 0 }));
vi.mock("@/app/(app)/settings/team-actions", () => ({
  发起连接动作: async () => { 调用.发起++; return { ok: true, 配对数字: "999999" }; },
  查连接动作: async () => { 调用.查++; return { ok: true, status: "pending" }; },
  取消连接动作: async () => ({ ok: true }),
}));
import ConnectPanel from "@/app/(app)/settings/ConnectPanel";

const 渲 = (x: Partial<Parameters<typeof ConnectPanel>[0]> = {}) =>
  renderToStaticMarkup(createElement(ConnectPanel, { 团名: "海川贸易", 我是建的人: false, 等授权: null, 本机客户: 0, onJoined: () => undefined, ...x }));

describe("新电脑连接团队的面板", () => {
  it("已经在等：直接显示那组数字和「不等了」，不再发申请", () => {
    const html = 渲({ 等授权: { 配对数字: "123456" }, 自动发起: true });
    expect(html).toContain("123 456");
    expect(html).toContain("不等了");
    expect(html).not.toContain("在我的另一台电脑或手机上允许");
    expect(调用.发起).toBe(0);
  });

  it("还没发：卡片上是按钮；本机已有客户时说清楚会带进团队、先备份", () => {
    const html = 渲({ 本机客户: 7 });
    expect(html).toContain("在我的另一台电脑或手机上允许");
    expect(html).toContain("这台电脑上已有的 7 位客户会带进团队");
    expect(html).toContain("自动备份");
    expect(渲()).not.toContain("会带进团队");
  });

  it("老板：写明手机批的管不了团队；业务员没有这句", () => {
    expect(渲({ 我是建的人: true })).toContain("管不了团队");
    expect(渲()).not.toContain("管不了团队");
  });

  it("框底部的「以后再说」放进来；卡片里没有", () => {
    expect(渲({ 尾: createElement("button", null, "以后再说") })).toContain("以后再说");
    expect(渲()).not.toContain("以后再说");
  });
});
