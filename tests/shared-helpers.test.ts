/**
 * 公共小工具（剪贴板、减弱动态）。原来各处各写一份，剪贴板一半没接失败：
 * 没授权、窗口没焦点、非 https 时 writeText 拒绝，人点了没反应。
 *
 * 守卫：src 下别处再直接写 navigator.clipboard / 裸的 prefers-reduced-motion 查询就红，
 * 免得又长出一份不接失败的。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 复制文字 } from "@/lib/clipboard";
import { 少动, 滚法 } from "@/lib/reduced-motion";

afterEach(() => vi.unstubAllGlobals());

describe("复制文字", () => {
  it("写成了回 true，写进去的就是原文", async () => {
    const 记: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => void 记.push(t) } });
    expect(await 复制文字("Subject: hi\n\n正文")).toBe(true);
    expect(记).toEqual(["Subject: hi\n\n正文"]);
  });

  it("writeText 拒绝（没授权 / 没焦点）回 false，不抛", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: () => Promise.reject(new DOMException("Document is not focused.", "NotAllowedError")) } });
    expect(await 复制文字("x")).toBe(false);
  });

  it("没有 navigator.clipboard（非 https）回 false，不抛", async () => {
    vi.stubGlobal("navigator", {});
    expect(await 复制文字("x")).toBe(false);
  });
});

describe("减弱动态", () => {
  it("没有 window（服务端）按没开算", () => {
    expect(少动()).toBe(false);
    expect(滚法()).toBe("smooth");
  });

  it("系统开了就直接跳，不滑", () => {
    vi.stubGlobal("window", { matchMedia: (q: string) => ({ matches: q === "(prefers-reduced-motion: reduce)" }) });
    expect(少动()).toBe(true);
    expect(滚法()).toBe("auto");
  });
});

describe("守卫：只许走公共小工具", () => {
  const 根 = path.join(__dirname, "..", "src");
  const 文件们 = (fs.readdirSync(根, { recursive: true }) as string[])
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => ({ f: f.split(path.sep).join("/"), s: fs.readFileSync(path.join(根, f), "utf8") }));

  it("navigator.clipboard 只在 lib/clipboard.ts 里出现", () => {
    expect(文件们.filter((x) => x.f !== "lib/clipboard.ts" && /navigator\.clipboard/.test(x.s)).map((x) => x.f)).toEqual([]);
  });

  it("prefers-reduced-motion 查询只在 lib/reduced-motion.ts 里写", () => {
    expect(文件们.filter((x) => x.f !== "lib/reduced-motion.ts" && /prefers-reduced-motion/.test(x.s)).map((x) => x.f)).toEqual([]);
  });
});
