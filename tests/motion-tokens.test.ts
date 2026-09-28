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
    // 四档 + 落印，一档不多：2026-09-28 之前实际有六档（160/180/200 挤在 40ms 里），注释却写四档
    const 档 = [...根.matchAll(/(--t(?:-[\w-]+)?):\s*\d+ms/g)].map((m) => m[1]).sort();
    expect(档).toEqual(["--t", "--t-fast", "--t-morph", "--t-press", "--t-seal"]);
  });

  it("并掉的档位没人再用", () => {
    // 删了定义、没删用处的话，var(--t-enter) 会悄悄变成 0 秒——不报错，只是那一下没了动效
    expect(css).not.toMatch(/var\(--t-(?:slow|enter)\)/);
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

  it("lib/motion.ts 和 :root 逐值一致，一个不多一个不少", async () => {
    /**
     * motion 认不了 CSS 变量，JS 那边只能抄一份数。抄的那份一漂，同一屏上 CSS 动的和 JS 动的
     * 就不是一套手感（2026-09-28 之前就是这样：Rise 0.42s、左栏底块第四条曲线）。照 palette.ts 那条钉住。
     */
    const { 曲线, 时长, 间隔 } = await import("@/lib/motion");
    const 名 = (前缀: string, k: string, 本名: string) => (k === 本名 ? 前缀 : `${前缀}-${k}`);

    const css时长 = Object.fromEntries([...根.matchAll(/(--t(?:-[\w-]+)?):\s*(\d+)ms/g)].map((m) => [m[1], Number(m[2]) / 1000]));
    const js时长 = Object.fromEntries(Object.entries(时长).map(([k, v]) => [名("--t", k, "base"), v]));
    expect(js时长, "时长对不上 :root").toEqual(css时长);

    const css曲线 = Object.fromEntries(
      [...根.matchAll(/(--ease(?:-[\w-]+)?):\s*cubic-bezier\(([^)]*)\)/g)].map((m) => [m[1], m[2].split(",").map(Number)]),
    );
    const js曲线 = Object.fromEntries(Object.entries(曲线).map(([k, v]) => [名("--ease", k, "ease"), [...v]]));
    expect(js曲线, "曲线对不上 :root").toEqual(css曲线);

    const stagger = /--stagger:\s*(\d+)ms/.exec(根);
    expect(stagger, "--stagger 应该定义在 :root").not.toBeNull();
    expect(间隔).toBe(Number(stagger![1]) / 1000);
  });

  it("JS 里的时长、间隔、曲线只许写在 lib/motion.ts", () => {
    /**
     * 镜像对上了还不够：别处照样可以绕开它直接写 0.42。这条扫 src 下所有 .ts/.tsx，
     * 抓的是 motion 那几个键的值里写死的数（`duration: 0.26`、`少动 ? 0 : 0.42`、`delay: i * 0.04`、
     * `staggerChildren: 0.1`）和写死的曲线（`ease: [..]`、`ease: "easeOut"`、cubic-bezier）。
     * 只认小数：`duration: 6` 是 antd 提示停几秒、`duration: 300 + …` 是演示数据里的通话时长，都不是动效。
     */
    const 根目录 = path.resolve(__dirname, "../src");
    const 去注释 = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, "")).replace(/^\s*\/\/.*$/gm, "");
    const 规矩: [RegExp, string][] = [
      // 值里任何位置出现小数都算：`少动 ? 0 : 0.18`、`时长(0.28)` 也是写死
      [/\b(?:duration|staggerChildren|delayChildren|repeatDelay)\s*:[^,}\n]*\d*\.\d/, "裸时长"],
      // delay 常写成 `Math.min(i, 8) * 0.04`，括号里有逗号，所以放宽到整个花括号
      [/\bdelay\s*:[^}\n]*\d*\.\d/, "裸间隔"],
      [/\bease\s*:\s*(?:\[|["'`])/, "裸曲线"],
      [/cubic-bezier\(/, "裸曲线"],
    ];
    const 文件 = (dir: string): string[] =>
      fs.readdirSync(dir).flatMap((n) => {
        const p = path.join(dir, n);
        if (fs.statSync(p).isDirectory()) return n === "generated" ? [] : 文件(p);
        return /\.tsx?$/.test(n) ? [p] : [];
      });
    const 散的: string[] = [];
    for (const f of 文件(根目录)) {
      const rel = path.relative(根目录, f).replaceAll("\\", "/");
      if (rel === "lib/motion.ts") continue;
      去注释(fs.readFileSync(f, "utf8"))
        .split("\n")
        .forEach((l, i) => {
          for (const [re, 叫] of 规矩) if (re.test(l)) 散的.push(`${rel}:${i + 1} ${叫}：${l.trim().slice(0, 120)}`);
        });
    }
    expect(散的, `这些地方还写着裸的动效数值，改成 lib/motion.ts 的 时长 / 曲线 / 间隔：\n${散的.join("\n")}`).toEqual([]);
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
