/**
 * R2 · 检查更新的异常场景（desktop/updater.js 原样 require，fetch 换成假网络）。
 *
 * 外加照抄 main.js 检查更新() 里的两处判断（:839-842 能不能原地装、:852-858 走不走差量），
 * 好把「feed 给了什么 → 最后整包还是差量、装不装得上」一路串起来看。这两处应该抽进 updater.js。
 *
 * 发版约定（memory / 发版检查清单）：
 *   - 官网 feed 是放行闸：真机验过才改 latest.json
 *   - 2026-10-02 起 Windows 一律整包（feed 的 win32 不给 zip / manifest）
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { 检查, 比版本 } = require_("../desktop/updater.js");

afterEach(() => vi.unstubAllGlobals());

/** 自家 feed / GitHub 各回什么。null = 不通；字符串 = 回了一段不是 JSON 的东西（CDN 错误页） */
function 假网络(feed: unknown, gh: unknown) {
  vi.stubGlobal("fetch", async (url: string) => {
    const 体 = String(url).includes("api.github.com") ? gh : feed;
    if (体 === null) throw new TypeError("fetch failed");
    if (typeof 体 === "string") return new Response(体, { status: 200, headers: { "Content-Type": "text/html" } });
    return new Response(JSON.stringify(体), { status: 200 });
  });
}

const 哈希 = "a".repeat(64);
const 官网feed = (v: string, 额外: object = {}) => ({
  version: v,
  url: "https://ai-daedalus.com/download.html",
  notes: "官网说明",
  dmg: `https://gitcode.example/${v}/DaedalusCRM-${v}-arm64.dmg`,
  sha256: 哈希,
  zip: `https://gitcode.example/${v}/DaedalusCRM-${v}-arm64.app.zip`,
  manifest: `https://gitcode.example/${v}/DaedalusCRM-${v}-arm64.manifest.json.gz`,
  manifest_sha256: 哈希,
  platforms: {
    "win32-x64": { version: v, url: "https://ai-daedalus.com/download.html", exe: `https://gitcode.example/${v}/DaedalusCRM-${v}-x64-setup.exe`, sha256: 哈希 },
  },
  ...额外,
});
const GitHub正式版 = (tag: string) => ({
  tag_name: tag,
  html_url: `https://github.com/x/y/releases/tag/${tag}`,
  body: "GitHub 说明",
  assets: [
    { name: `DaedalusCRM-${tag}-arm64.dmg`, browser_download_url: `https://github.com/dl/${tag}-arm64.dmg`, digest: `sha256:${"b".repeat(64)}`, size: 160 << 20 },
    { name: `DaedalusCRM-${tag}-arm64.app.zip`, browser_download_url: `https://github.com/dl/${tag}-arm64.app.zip`, digest: `sha256:${"c".repeat(64)}` },
    { name: `DaedalusCRM-${tag}-arm64.manifest.json.gz`, browser_download_url: `https://github.com/dl/${tag}.manifest.json.gz`, digest: `sha256:${"d".repeat(64)}` },
    { name: `DaedalusCRM-${tag}-x64-setup.exe`, browser_download_url: `https://github.com/dl/${tag}-x64-setup.exe`, digest: `sha256:${"e".repeat(64)}` },
    { name: `DaedalusCRM-${tag}-x64-win.zip`, browser_download_url: `https://github.com/dl/${tag}-x64-win.zip`, digest: `sha256:${"f".repeat(64)}` },
    { name: `DaedalusCRM-${tag}-x64-win.manifest.json.gz`, browser_download_url: `https://github.com/dl/${tag}-x64-win.manifest.json.gz`, digest: `sha256:${"0".repeat(64)}` },
  ],
});

const Mac = { platform: "darwin", arch: "arm64" };
const Win = { platform: "win32", arch: "x64" };

/** 对齐main.js的平台策略：Mac差量，Windows完整安装包。 */
function 会怎么装(新版: Record<string, unknown> | null, platform: string, { 已打包 = true, Mac能原地 = true } = {}) {
  if (!新版) return "不提示";
  // 和 main.js 检查更新() 里那段一致：没有能核对的 sha256，两个平台都不原地装（B-7，2026-10-04 修）
  const 哈希可核 = /^[a-f0-9]{64}$/i.test(String(新版.sha256 || ""));
  const 可原地 =
    platform === "win32"
      ? { ok: 已打包 && !!新版.exe && 哈希可核 }
      : 新版.dmg && 哈希可核
        ? { ok: Mac能原地 }
        : { ok: false };
  if (!可原地.ok) return "手动（打开下载页）";
  if (platform === "darwin" && 新版.zip && 新版.manifest) return "差量";
  return "整包";
}

describe("版本号比较", () => {
  it.each([
    ["0.46.10", "0.46.9", 1],
    ["0.46.9", "0.46.10", -1],
    ["0.47.0", "0.46.14", 1],
    ["v0.47.0", "0.47.0", 0],
    ["0.47", "0.47.0", 0],
    ["0.47.0", "0.47.0-beta", 1],
    ["1.0.0", "0.99.99", 1],
    ["0.46.15", "0.46.15 ", 0],
    ["desktop-updates", "0.0.1", -1], // 滚动 Release 的 tag 不是版本号：永远不算新
  ])("比版本(%s, %s) 的符号是 %d", (a, b, 符号) => {
    expect(Math.sign(比版本(a, b))).toBe(符号);
  });

  it("feed 里 version 写成数字 0.47（手写 JSON 漏了引号）：当 0.47.0，不崩", () => {
    expect(Math.sign(比版本(0.47 as unknown as string, "0.46.14"))).toBe(1);
  });
});

describe("feed 字段缺失 / 损坏", () => {
  it("feed 回了一页 HTML（CDN 错误页 200）：当不通，GitHub 兜底，不抛", async () => {
    假网络("<!doctype html><title>502</title>", GitHub正式版("v0.46.14"));
    const r = await 检查({ 当前版本: "0.46.13", ...Mac });
    expect(r?.版本).toBe("v0.46.14");
  });

  it("feed 是数组 / null / 空对象：都当没有，不抛", async () => {
    for (const 坏 of [[], {}, { platforms: null }, { version: "" }]) {
      假网络(坏, null);
      expect(await 检查({ 当前版本: "0.46.13", ...Mac })).toBeNull();
      expect(await 检查({ 当前版本: "0.46.13", ...Win })).toBeNull();
    }
  });

  it("feed 只有 version（没 dmg、没 url）：Mac 退回打开下载页，不去下一个 undefined", async () => {
    假网络({ version: "0.46.15" }, null);
    const r = await 检查({ 当前版本: "0.46.14", ...Mac });
    expect(r).toMatchObject({ 版本: "0.46.15", dmg: null, 地址: "https://ai-daedalus.com/download.html" });
    expect(会怎么装(r, "darwin")).toBe("手动（打开下载页）");
  });

  it("feed 的 win32 没有 sha256：Windows 不原地装，改成手动", async () => {
    const f = 官网feed("0.46.15");
    delete (f.platforms["win32-x64"] as Record<string, unknown>).sha256;
    假网络(f, null);
    expect(会怎么装(await 检查({ 当前版本: "0.46.14", ...Win }), "win32")).toBe("手动（打开下载页）");
  });

  /*
    【B-7，2026-10-04 修】Mac 这边 feed 漏了 sha256（手写 latest.json 时漏一行）：原来照样原地下载、安装，
    下载完 `if (新版.sha256)` 才校验，没有就**不校验**直接换包。Windows 同样情况会拒绝。
    现在两个平台一样：没有能核对的哈希就不原地装（main.js 检查更新() 的 哈希可核）。
  */
  it("【B-7】main.js 里 Mac 那一支也看 哈希可核（上面的 会怎么装 是照抄的，这条防两边又对不上）", () => {
    const src = readFileSync(resolve(__dirname, "../desktop/main.js"), "utf8");
    const 段 = src.slice(src.indexOf("const 哈希可核"), src.indexOf("if (!可原地.ok)"));
    expect(段).toMatch(/!哈希可核\s*\?\s*\{ ok: false/);
    expect(src).not.toMatch(/if \(新版\.sha256\) await 安装\.校验sha256/);
  });

  it("【B-7】feed 的 Mac 那份漏了 sha256（且这一版没给差量 / 差量退回整包）：不该不校验就原地换包", async () => {
    假网络(官网feed("0.46.15", { sha256: undefined, zip: undefined, manifest: undefined }), null);
    const r = await 检查({ 当前版本: "0.46.14", ...Mac });
    expect(r?.sha256).toBeNull();
    expect(会怎么装(r, "darwin")).not.toMatch(/整包|差量/);
  });

  /*
    【C】dmg / zip / manifest / exe 这几个地址不校验协议（备用 那几个是校验的，updater.js:65-73）：
    feed 里写成 http:// 也照下。有 sha256 时内容被换会被拦下，所以只是 C。
  */
  it("R-004 修后：feed的HTTP制品不能自动下载", async () => {
    假网络(官网feed("0.46.15", { dmg: "http://insecure.example/x.dmg" }), null);
    expect((await 检查({ 当前版本: "0.46.14", ...Mac }))?.dmg).toBeNull();
  });
});

describe("Windows 只走整包", () => {
  it("只有官网 feed（win32 不给 zip / manifest）：Windows 整包", async () => {
    假网络(官网feed("0.46.15"), null);
    const r = await 检查({ 当前版本: "0.46.14", ...Win });
    expect(r?.zip ?? null).toBeNull();
    expect(会怎么装(r, "win32")).toBe("整包");
  });

  /*
    【A · 已知（全面排查 5-A7）】GitHub 的正式 Release 比 feed 新（大版本 CI 直接建正式 Release）：
    Windows 拿到 GitHub 那一支，带着 -x64-win.zip 和清单 → 走差量，绕开「10-02 起 Windows 一律整包」。
  */
  it("【A-3 真坏】GitHub 正式版比 feed 新：Windows 也不许走差量", async () => {
    假网络(官网feed("0.46.15"), GitHub正式版("v0.47.0"));
    const r = await 检查({ 当前版本: "0.46.14", ...Win });
    expect(会怎么装(r, "win32")).toBe("整包");
  });
});

describe("GitHub 源和官网 feed 谁优先", () => {
  /*
    【A · 已知（5-A7），下次发 x.y.0 之前必须改】官网 feed 是放行闸（真机验过才改 latest.json），
    但 updater 是「两边谁新听谁的」：0.47.0 一打 tag、CI 一建正式 Release，所有桌面端立刻收到，
    官网还没放行、真机还没验。最小改法见报告：feed 拿到了就只听 feed，feed 不通才看 GitHub；
    GitHub 那一支在 win32 上把 zip / manifest 置空。
  */
  it("【A-3 真坏】feed 还在 0.46.15、GitHub 已有 v0.47.0：Mac 应当只升到 0.46.15", async () => {
    假网络(官网feed("0.46.15"), GitHub正式版("v0.47.0"));
    const r = await 检查({ 当前版本: "0.46.14", ...Mac });
    expect(r?.版本).toBe("0.46.15");
  });

  it("【A-3 真坏】feed 说已是最新（0.46.14）、GitHub 有 v0.47.0：不该提示", async () => {
    假网络(官网feed("0.46.14"), GitHub正式版("v0.47.0"));
    expect(await 检查({ 当前版本: "0.46.14", ...Mac })).toBeNull();
  });

  it("feed 不通（被墙 / 站挂了）：GitHub 兜底照常提示", async () => {
    假网络(null, GitHub正式版("v0.47.0"));
    expect((await 检查({ 当前版本: "0.46.14", ...Mac }))?.版本).toBe("v0.47.0");
  });

  it("两边一样新：用官网的（说明、镜像地址、备用都在它那里）", async () => {
    假网络(官网feed("0.47.0"), GitHub正式版("v0.47.0"));
    const r = await 检查({ 当前版本: "0.46.14", ...Mac });
    expect(r?.说明).toBe("官网说明");
    expect(String(r?.dmg)).toContain("gitcode.example");
  });

  it("小版本挂在 prerelease 的滚动 Release 上：/releases/latest 看不到，只有 feed 说了算", async () => {
    假网络(官网feed("0.46.15"), GitHub正式版("v0.46.0"));
    expect((await 检查({ 当前版本: "0.46.14", ...Mac }))?.版本).toBe("0.46.15");
  });
});
