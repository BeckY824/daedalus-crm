/**
 * 动效的底座（globals.css 的三条曲线四档时长）和那条硬规矩：
 * **开了「减弱动态效果」之后，界面不许再有位移。**
 *
 * 为什么用读文件的方式测：动效本身没什么可断言的（0.26 秒好看还是 0.3 秒好看，测不出来），
 * 但"全站只有这三条曲线""按下那档最短""减弱动态时不位移"这三件是规矩，规矩测得出来。
 * 规矩一旦破了不会有人发现——界面照样能用，只是慢慢变回一盘散沙。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.resolve(__dirname, "../src/app/globals.css"), "utf8");
const 根 = css.slice(css.indexOf(":root"), css.indexOf("\n}"));

describe("动效底座", () => {
  it("三条曲线、四档时长都在 :root 里", () => {
    for (const t of ["--ease:", "--ease-spring:", "--ease-morph:"]) {
      expect(根, `${t} 应该定义在 :root`).toContain(t);
    }
    for (const t of ["--t-press:", "--t-fast:", "--t:", "--t-enter:", "--t-morph:"]) {
      expect(根, `${t} 应该定义在 :root`).toContain(t);
    }
  });

  it("按下那一档最短：90ms，比悬停还快", () => {
    const 取 = (name: string) => Number(/(\d+)ms/.exec(根.slice(根.indexOf(name)))?.[1]);
    expect(取("--t-press:")).toBe(90);
    expect(取("--t-press:")).toBeLessThan(取("--t-fast:"));
  });

  it("曲线只在 :root 里写死，别处一律用 token", () => {
    /**
     * 散在各处的 bezier 是"每次各拍一个"的开始。JS 那边（motion 不认 CSS 变量）
     * 只能写数值，但样式表这边没有这个借口。
     */
    // 注释里提到别人的曲线不算数（比如那句"antd 自带的是 .08,.82,.17,1"）
    const 去注释 = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const 正文 = 去注释.slice(去注释.indexOf("\n}", 去注释.indexOf(":root")));
    const 散的 = [...正文.matchAll(/cubic-bezier\([^)]*\)/g)].map((m) => m[0]);
    expect(散的, `样式表里还有写死的曲线：${散的.join(" / ")}`).toEqual([]);
  });

  it("上限 320ms：超过就是在让人等", () => {
    // --t-seal 单独一条规矩，见下一条
    const 毫秒 = [...css.matchAll(/--t(?!-seal)[\w-]*:\s*(\d+)ms/g)].map((m) => Number(m[1]));
    expect(Math.max(...毫秒)).toBeLessThanOrEqual(320);
  });

  it("只有落印能放到 480ms，而且只许落印用它", () => {
    /**
     * 2026-09-28 拍板的唯一例外：建议卡确认时落的那个印。它是回执不是等待（数据已经写了、还能撤），
     * 一天十几次，盖章要三段才看得出。其余照旧 ≤320——所以要钉住「只有它」，
     * 不然 480 很快会被拿去给别的东西用。
     */
    const 值 = [...css.matchAll(/--t-seal:\s*(\d+)ms/g)].map((m) => Number(m[1]));
    expect(值.length).toBeGreaterThan(0);
    expect(Math.max(...值)).toBeLessThanOrEqual(480);
    const 用处 = [...css.matchAll(/([^{}]*)\{[^{}]*var\(--t-seal\)/g)].map((m) => m[1].trim());
    expect(用处.length).toBeGreaterThan(0);
    const 别处 = 用处.filter((sel) => !/seal/.test(sel));
    expect(别处, `这些选择器不是落印，不许用 --t-seal：${别处.join(" / ")}`).toEqual([]);
  });

  it("开了「减弱动态」之后不许再有位移", () => {
    const i = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(i).toBeGreaterThan(-1);
    const 块 = css.slice(i);
    // 时长归零挡不住位移本身：按下去照样缩，只是缩得飞快，而那正是开这个开关的人不想要的
    expect(块).toContain("transform: none !important");
    expect(块).toContain("scale: none !important");
  });
});
