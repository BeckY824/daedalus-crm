/**
 * 主题（设置 → 外观 → 主题）的「必须一致的清单」。
 *
 * 一套主题要四处对得上：lib/appearance.ts 的 主题表、src/app/skins/<key>.css、layout.tsx 的 import、
 * 以及主题文件里的 token 名和 globals.css :root 的 token 名。**哪一处漏了都不报错**——
 * 主题表里有、文件没引入：选了之后什么都不变；token 名拼错（--brand-dep）：那一项悄悄沿用现状，
 * 出来的样子一半账簿一半蓝。所以逐条钉住。
 *
 * 另外三条是主题的规矩本身：形状规则每套 ≤10 条、选择器不许漏到别的主题、对比度够读。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 主题表 } from "@/lib/appearance";
import { ANTD_CSS_VAR_KEY } from "@/lib/theme";
import { 源, 主题目录, 拆块, 变量, 根变量, 主题文件, 去注释 } from "./skin-css";

const 换皮 = 主题表.filter((x) => x.key !== "now").map((x) => x.key as string);
const layout = fs.readFileSync(path.join(源, "app/layout.tsx"), "utf8");

describe("主题清单", () => {
  it("主题表 ↔ skins/*.css ↔ layout 引入，三处一一对应", () => {
    const 文件 = 主题文件().map((x) => x.key).sort();
    expect(文件, "主题表里的每一套（现状除外）都要有 skins/<key>.css，反过来也一样").toEqual([...换皮].sort());
    for (const k of [...换皮, "shared"]) expect(layout, `layout.tsx 没引入 ./skins/${k}.css`).toContain(`import "./skins/${k}.css";`);
  });

  it("主题只许定义 :root 里已有的 token 名（拼错不会报错，只会悄悄沿用现状）", () => {
    const 有 = 根变量();
    const 错: string[] = [];
    for (const { key, 文 } of 主题文件())
      for (const b of 拆块(文).filter((b) => b.token块))
        for (const k of 变量(b.体).keys()) if (!有.has(k)) 错.push(`${key}.css ${k}`);
    expect(错, `这些名字 globals.css 的 :root 里没有：\n${错.join("\n")}`).toEqual([]);
  });

  it("每套都有自己的 token 块，而且 [data-skin-preview] 小样和它是同一块", () => {
    for (const { key, 文 } of 主题文件()) {
      const 主块 = 拆块(文).find((b) => b.token块 && b.选择器.includes(`:root[data-skin="${key}"],`));
      expect(主块, `${key}.css 缺 :root[data-skin="${key}"] 那块`).toBeTruthy();
      expect(主块!.选择器, "设置里的小样读的就是这块").toContain(`[data-skin-preview="${key}"]`);
    }
  });

  it("选择器不许漏到别的主题：每条都挂在自己的 data-skin 下", () => {
    const 漏: string[] = [];
    for (const { key, 文 } of 主题文件())
      for (const b of 拆块(文))
        for (const sel of b.选择器.split(/,(?![^()]*\))/).map((x) => x.trim()))
          if (!sel.startsWith(`:root[data-skin="${key}"]`) && sel !== `[data-skin-preview="${key}"]`) 漏.push(`${key}.css: ${sel}`);
    expect(漏).toEqual([]);
  });

  it("形状规则每套不超过 10 条：规则多了，主题就成了另一个产品", () => {
    for (const { key, 文 } of 主题文件()) {
      const n = 拆块(文).filter((b) => !b.token块).length;
      expect(n, `${key}.css 有 ${n} 条形状规则`).toBeLessThanOrEqual(10);
    }
  });

  it("主题文件里不嵌套 @media / @keyframes：减弱动态只在 globals.css 一处管，主题没有机会绕过去", () => {
    for (const { key, 文 } of 主题文件()) expect(去注释(文), key).not.toMatch(/@media|@keyframes|@supports/);
  });
});

describe("antd 跟着主题走（skins/shared.css）", () => {
  const shared = 去注释(fs.readFileSync(path.join(主题目录, "shared.css"), "utf8"));

  it("挂的类名和 lib/theme.ts 钉死的 cssVar key 是同一个", () => {
    const 用到 = new Set([...shared.matchAll(/\.(css-var-[\w-]+)/g)].map((m) => m[1]));
    expect([...用到]).toEqual([ANTD_CSS_VAR_KEY]);
  });

  it("每条都只在换皮时生效，现状下 antd 原样", () => {
    for (const b of 拆块(shared))
      for (const sel of b.选择器.split(/,(?![^()]*\))/).map((x) => x.trim()))
        expect(sel, "shared.css 的选择器要以 :root[data-skin]:not([data-skin=\"now\"]) 开头").toMatch(/^:root\[data-skin\]:not\(\[data-skin="now"\]\)/);
  });

  it("覆盖的 --ant-* 名字 antd 真有（拼错一个，那一项就还是蓝的）", async () => {
    const { theme } = await import("antd");
    const 全局 = new Set(Object.keys(theme.getDesignToken()).map((k) => "--ant-" + k.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z])([A-Z][a-z])/g, "$1-$2").toLowerCase()));
    // 组件变量的名字前缀是组件名（--ant-table-…、--ant-button-…），不一定和类名一样（按钮的类名是 .ant-btn）
    const 驼峰 = (x: string) => x.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    const 源码 = (dir: string) => {
      if (!dir) return "";
      const d = path.resolve(__dirname, "../node_modules/antd/es", dir, "style");
      return fs.existsSync(d) ? fs.readdirSync(d).map((n) => fs.readFileSync(path.join(d, n), "utf8")).join("\n") : "";
    };
    const 错: string[] = [];
    for (const b of 拆块(shared)) {
      const 组件块 = /\.css-var-dd:is\(/.test(b.选择器);
      for (const k of 变量(b.体).keys()) {
        if (全局.has(k)) continue;  // 全局名在组件块里重设也行（只在那一层生效，比如弹窗的圆角）
        const m = /^--ant-([a-z]+)-(.+)$/.exec(k);
        // 分页里那几个输入框的变量是借 Input 的 token 算的
        const 借用: Record<string, string> = { pagination: "input" };
        if (!组件块 || !m || !(源码(m[1]) + 源码(借用[m[1]] ?? "")).includes(驼峰(m[2]))) 错.push(k);
      }
    }
    expect(错, `antd 没有这些变量：${错.join("、")}`).toEqual([]);
  });
});

/* ---------- 对比度：换了色板，字还得读得清 ---------- */
function 亮度(hex: string) {
  const h = hex.replace("#", "");
  const 全 = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(全.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const 对比 = (a: string, b: string) => {
  const [x, y] = [亮度(a), 亮度(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
/** 一套主题在某个底色下的全部值：:root → 主题块 → 白底块，var() 一路解到 hex */
function 解(key: string, 白底: boolean): (name: string) => string | undefined {
  const 表 = new Map(根变量());
  if (白底) 表.set("--page-bg", "var(--panel)");
  const 文 = 主题文件().find((x) => x.key === key)?.文 ?? "";
  for (const b of 拆块(文).filter((b) => b.token块 && (白底 || !b.选择器.includes("data-paper")))) for (const [k, v] of 变量(b.体)) 表.set(k, v);
  const 取 = (n: string, 深 = 0): string | undefined => {
    const v = 表.get(n);
    if (!v || 深 > 8) return undefined;
    const m = /^var\((--[\w-]+)\)$/.exec(v);
    return m ? 取(m[1], 深 + 1) : /^#[0-9a-f]{3,8}$/i.test(v) ? v : undefined;
  };
  return 取;
}

describe("对比度（WCAG）：每套主题 × 原底 / 白底", () => {
  // [字, 底, 下限]。正文 7（AAA）；说明、状态字、按钮字 4.5（AA）
  const 对: [string, string, number][] = [
    ["--ink", "--panel", 7],
    ["--ink", "--page-bg", 7],
    ["--ink-soft", "--panel", 4.5],
    ["--text-muted", "--panel", 4.5],
    ["--text-muted", "--page-bg", 4.5],
    ["--on-ink", "--brand", 4.5],
    ["--brand-deep", "--brand-bg", 4.5],
    ["--success-text", "--success-bg", 4.5],
    ["--warning-text", "--warning-bg", 4.5],
    ["--danger-text", "--danger-bg", 4.5],
    ["--nav-on-fg", "--nav-on-bg", 4.5],
  ];
  for (const key of ["now", ...换皮])
    for (const 白底 of [false, true])
      it(`${key} · ${白底 ? "白底" : "原底"}`, () => {
        const 取 = 解(key, 白底);
        const 差: string[] = [];
        for (const [字, 底, 下限] of 对) {
          const a = 取(字);
          // nav-on-bg 可以是 transparent（高级）：那时字压在地面上
          const b = 取(底) ?? (底 === "--nav-on-bg" ? 取("--page-bg") : undefined);
          if (!a || !b) { 差.push(`${字} / ${底} 解不出颜色`); continue; }
          const r = 对比(a, b);
          // 0.01 的余量：现状的主按钮白字压 #2f6bff 是 4.497，四舍五入就是 4.5，不为这个改现状
          if (r + 0.01 < 下限) 差.push(`${字} ${a} 在 ${底} ${b} 上只有 ${r.toFixed(2)}，要 ≥${下限}`);
        }
        expect(差).toEqual([]);
      });
});
