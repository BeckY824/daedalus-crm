/**
 * 外观（设置 → 外观）。本地存的值不可信；首次绘制前那段脚本和设置页读的是同一套规矩。
 * 两边对不上的后果：刷新时先按脚本认的挂一个样子，React 起来后又换成另一个——闪一下。
 */
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { 读外观, 外观预设脚本, 外观键, 默认外观 } from "@/lib/appearance";

function 跑脚本(存的: string | null) {
  const dataset: Record<string, string> = {};
  vm.runInNewContext(外观预设脚本, {
    localStorage: { getItem: (k: string) => (k === 外观键 ? 存的 : null) },
    document: { documentElement: { dataset } },
  });
  return { paper: dataset.paper, skin: dataset.skin };
}

describe("外观", () => {
  it("没存过、坏 JSON、认不出的值，一律回到默认（现在的样子）", () => {
    for (const raw of [null, "", "{", '"white"', '{"paper":"pink","skin":"neon"}']) {
      expect(读外观(raw)).toEqual(默认外观);
      expect(跑脚本(raw)).toEqual(默认外观);
    }
  });

  it("存了白底：设置页和首次绘制前的脚本认出来的一样", () => {
    const raw = JSON.stringify({ paper: "white", skin: "now" });
    expect(读外观(raw)).toEqual({ paper: "white", skin: "now" });
    expect(跑脚本(raw)).toEqual(读外观(raw));
  });

  it("五套主题（现状、像素、科技、高级、账簿）两边都认，底色和主题任意组合", async () => {
    const { 主题表 } = await import("@/lib/appearance");
    expect(主题表.map((x) => x.key)).toEqual(["now", "pixel", "tech", "luxe", "ledger"]);
    for (const { key } of 主题表)
      for (const paper of ["tone", "white"]) {
        const raw = JSON.stringify({ paper, skin: key });
        expect(读外观(raw)).toEqual({ paper, skin: key });
        expect(跑脚本(raw)).toEqual(读外观(raw));
      }
  });

  it("白底只换地面，不许在 :root 之外写色值", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../src/app/globals.css"), "utf8");
    const 块 = /:root\[data-paper="white"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(块).toContain("--page-bg");
    expect(块).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("根布局把脚本放在 <head> 里（放进 body 就晚了一帧，会闪）", () => {
    const layout = fs.readFileSync(path.resolve(__dirname, "../src/app/layout.tsx"), "utf8");
    expect(layout).toMatch(/<head>[\s\S]*外观预设脚本[\s\S]*<\/head>/);
  });
});
