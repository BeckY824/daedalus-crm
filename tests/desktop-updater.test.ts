/**
 * 桌面端的「检查更新」查两个源：官网的 latest.json（自家源）和 GitHub 的最新 Release。
 *
 * 这里钉的是**取谁**。原来的写法是「先查自家源，查到就算数」，GitHub 只在自家源
 * 不通时兜底——于是 0.19.0 / 0.19.1 / 0.20.0 连着三次发版忘了改 latest.json，
 * 它就把所有人按在 0.18.1 上，而 GitHub 上明明已经有新包。
 * 一个手写文件不该有能力盖掉真实的发布记录，所以现在是谁新听谁的。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { 检查 } = require_("../desktop/updater.js");

/** 按 URL 分发假响应。给 null 表示这个源不通（超时、被墙、站挂了） */
function 假网络(自家: unknown, gh: unknown) {
  vi.stubGlobal("fetch", async (url: string) => {
    const 体 = String(url).includes("api.github.com") ? gh : 自家;
    if (体 === null) throw new Error("不通");
    return { ok: true, json: async () => 体 };
  });
}

const 自家 = (v: string) => ({ version: v, url: "https://ai-daedalus.com/download.html", notes: "自家的说明" });
const GitHub = (tag: string) => ({ tag_name: tag, html_url: `https://github.com/x/y/releases/tag/${tag}`, body: "GitHub 的说明" });

afterEach(() => vi.unstubAllGlobals());

describe("检查更新取哪个源", () => {
  it("自家源过期时，GitHub 上更新的版本要能顶上来——这正是 0.18.1 把人按住的那次", async () => {
    假网络(自家("0.18.1"), GitHub("v0.20.1"));
    const 结果 = await 检查({ 当前版本: "0.14.0" });
    expect(结果?.版本).toBe("v0.20.1");
  });

  it("自家源更新时用自家的，说明文案也用它的（那是写给人看的）", async () => {
    假网络(自家("0.21.0"), GitHub("v0.20.1"));
    const 结果 = await 检查({ 当前版本: "0.20.0" });
    expect(结果?.版本).toBe("0.21.0");
    expect(结果?.说明).toBe("自家的说明");
  });

  it("两边同一个版本时用自家的", async () => {
    假网络(自家("0.20.1"), GitHub("v0.20.1"));
    const 结果 = await 检查({ 当前版本: "0.14.0" });
    expect(结果?.说明).toBe("自家的说明");
  });

  it("GitHub 被墙也不影响：自家源照常用", async () => {
    假网络(自家("0.20.1"), null);
    expect((await 检查({ 当前版本: "0.14.0" }))?.版本).toBe("0.20.1");
  });

  it("自家站挂了也不影响：GitHub 兜底", async () => {
    假网络(null, GitHub("v0.20.1"));
    expect((await 检查({ 当前版本: "0.14.0" }))?.版本).toBe("v0.20.1");
  });

  it("两边都不通就当没有新版，不打扰用户", async () => {
    假网络(null, null);
    expect(await 检查({ 当前版本: "0.14.0" })).toBeNull();
  });

  it("已经是最新了就不提示", async () => {
    假网络(自家("0.20.1"), GitHub("v0.20.1"));
    expect(await 检查({ 当前版本: "0.20.1" })).toBeNull();
  });

  it("用户跳过的版本不再提示，但更新的版本照样提示", async () => {
    假网络(自家("0.18.1"), GitHub("v0.20.1"));
    expect(await 检查({ 当前版本: "0.14.0", 跳过的版本: "0.20.1" })).toBeNull();
    expect((await 检查({ 当前版本: "0.14.0", 跳过的版本: "0.19.0" }))?.版本).toBe("v0.20.1");
  });
});
