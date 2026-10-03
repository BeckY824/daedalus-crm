/**
 * 毛玻璃：系统开了「减少透明度」时一律实底（2026-10-03）。
 * 壳是裸 JS、跑在 Electron 里，单测起不来窗口——钉住源码里那几处，改坏了当场红。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 根 = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(根, "desktop/main.js"), "utf8");
const 外观 = fs.readFileSync(path.join(根, "src/app/(app)/settings/AppearanceTab.tsx"), "utf8");

describe("减少透明度", () => {
  it("玻璃开着 要问过系统；系统中途改了当场跟着变", () => {
    expect(main).toMatch(/function 系统要少透明\(\)\s*\{\s*return nativeTheme\.prefersReducedTransparency === true;/);
    expect(main).toMatch(/function 玻璃开着\(\)\s*\{\s*return 玻璃可用\(\) && 读配置\(\)\.glass !== false && !系统要少透明\(\);/);
    expect(main).toMatch(/nativeTheme\.on\("updated"/);
  });
  it("设置里拨开关也按系统那项算，并把原因交给页面", () => {
    expect(main).toMatch(/shell:glass", \(\) => \(\{ 可用: 玻璃可用\(\), 开: 玻璃开着\(\), 系统关了: 系统要少透明\(\) \}\)/);
    expect(外观).toContain("减少透明度");
  });
  it("默认开（config.json 里没写 glass 就是开）", () => {
    expect(main).toContain('读配置().glass !== false');
  });
});
