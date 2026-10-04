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

/*
  毛玻璃下两处「透过去」的回归（视觉问题，单测钉住 CSS 那一行；真机多壁纸截图仍在手点单里）：
    D-114 登录页表单那一栏曾是 72% 不透明，桌面图标透成白斑——要 ≥ 95%
    D-117 整页滚动条的轨道是透明的，右边露出一条没罩过、偏深的壁纸——轨道要铺底色
*/
describe("毛玻璃下不该透的地方（D-114 / D-117）", () => {
  const css = fs.readFileSync(path.join(根, "src/app/globals.css"), "utf8");
  /** 取某个选择器那条规则的声明块（选择器要原样出现在规则开头那一行） */
  const 规则 = (选择器: string) => {
    const i = css.split("\n").findIndex((l) => l.split("{")[0].split(",").map((x) => x.trim()).includes(选择器));
    expect(i, `globals.css 里找不到 ${选择器}`).toBeGreaterThanOrEqual(0);
    const 起 = css.split("\n").slice(0, i).join("\n").length;
    return css.slice(css.indexOf("{", 起) + 1, css.indexOf("}", 起));
  };

  it("D-114 毛玻璃登录页的表单那一栏：底色是 --panel 至少 95%，不让桌面图标透上来", () => {
    const 块 = 规则("html.glass .auth-main");
    const 比 = Number(/background:\s*color-mix\(in srgb, var\(--panel\) (\d+)%, transparent\)/.exec(块)?.[1]);
    expect(比, 块).toBeGreaterThanOrEqual(95);
  });

  it("D-117 毛玻璃下整页滚动条的轨道铺了底色（不是 transparent）", () => {
    const 块 = 规则("html.glass::-webkit-scrollbar-track");
    expect(块).toMatch(/background:\s*color-mix\(in srgb, var\(--panel\)/);
    expect(块).not.toMatch(/background:\s*transparent/);
  });
});
