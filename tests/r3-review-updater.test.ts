/**
 * 第三轮对抗复查 · 更新只听 feed（49170e0）
 *
 * 修法：`if (gh?.tag_name && !自家?.version)`——「自家」是**这个平台**在 feed 里的那一条。
 * 于是 feed 取得到、但这个平台那条不在（运营把 Windows 那条先撤下来按住），被当成「feed 取不到」，
 * GitHub 兜底照样把新版推给 Windows，而且带着 -win.zip 走差量。feed 整个取不到 / 回来的不是 JSON 时同理。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { 检查 } = require_("../desktop/updater.js");

afterEach(() => vi.unstubAllGlobals());

const win = { 当前版本: "0.46.14", platform: "win32", arch: "x64" };
const GitHub新版 = {
  tag_name: "v0.47.0",
  html_url: "https://github.com/x/y/releases/tag/v0.47.0",
  body: "",
  assets: [
    { name: "Daedalus-CRM-0.47.0-x64-setup.exe", browser_download_url: "https://example.com/setup.exe", digest: `sha256:${"a".repeat(64)}`, size: 100 << 20 },
    { name: "Daedalus-CRM-0.47.0-x64-win.zip", browser_download_url: "https://example.com/win.zip" },
    { name: "Daedalus-CRM-0.47.0-x64-win.manifest.json.gz", browser_download_url: "https://example.com/win.manifest.json.gz", digest: `sha256:${"b".repeat(64)}` },
    { name: "Daedalus-CRM-0.47.0-arm64.dmg", browser_download_url: "https://example.com/mac.dmg" },
  ],
};

function 假网络(feed: unknown | "坏JSON", gh: unknown) {
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).includes("api.github.com")) return { ok: true, json: async () => gh };
    if (feed === null) throw new Error("不通");
    if (feed === "坏JSON") return { ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } };
    return { ok: true, json: async () => feed };
  });
}

describe("feed 是放行的闸：取得到时，这个平台没放行就不该更新", () => {
  it("feed 只放行了 Mac（Windows 那条先撤下按住）：Windows 不该从 GitHub 拿到 0.47.0", async () => {
    假网络({ platforms: { "darwin-arm64": { version: "0.47.0", dmg: "https://example.com/mac.dmg" } } }, GitHub新版);
    const r = await 检查(win);
    expect(r?.版本 ?? null, "feed 里没有 win32-x64 = 没放行").toBeNull();
  });

  it("feed 里 Windows 那条还是 0.46.14（Mac 先发）：Windows 不该被 GitHub 推到 0.47.0", async () => {
    假网络({ platforms: { "darwin-arm64": { version: "0.47.0" }, "win32-x64": { version: "0.46.14", exe: "https://example.com/old.exe" } } }, GitHub新版);
    expect(await 检查(win)).toBeNull(); // 这条是绿的：有那一条时只听它
  });
});

describe("feed 取不到时 GitHub 兜底：Windows 也不该走差量（「Windows 一律整包」）", () => {
  it.each([
    ["站挂了 / 超时", null],
    ["回来的不是 JSON（CDN 错误页）", "坏JSON"],
  ])("%s：兜底拿到的 Windows 更新带着 -win.zip 和清单 → main.js 会走差量", async (_说明, feed) => {
    假网络(feed, GitHub新版);
    const r = await 检查(win);
    expect(r?.版本).toBe("v0.47.0");
    expect(r?.exe).toBe("https://example.com/setup.exe");
    expect({ zip: r?.zip ?? null, manifest: r?.manifest ?? null }).toEqual({ zip: null, manifest: null });
  });
});
