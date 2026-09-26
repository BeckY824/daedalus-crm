/**
 * 色值只许在两个地方写死：globals.css 的 :root 和 lib/palette.ts。
 *
 * 2026-09-18 盘点：全站 79 个不同的 hex、170 多处，同一个浅蓝四个版本，
 * 主蓝有两个（#2f6bff 和 antd 的 #1668dc 并存了半年没人发现）。
 * 这不是审美问题，是"每次各拍一个"的必然结果——:root 顶上那段注释早就写了
 * "页面里不再出现裸 hex"，但没有守卫的规矩就是没有规矩（动效那套能守住，
 * 正是因为 motion-tokens.test.ts 钉着）。
 *
 * 两条：
 *   1. :root 和 palette.ts 之外不许有 hex——散一个就红，红的那行告诉你该用哪个 token
 *   2. palette.ts 里的每个值都必须在 :root 里有同样的值——两份镜像不许漂
 * Logo 是品牌图形不是界面色，放行。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 根目录 = path.resolve(__dirname, "../src");
const css = fs.readFileSync(path.join(根目录, "app/globals.css"), "utf8");
// 去注释时把块注释换成同样多的换行，报出来的行号才对得上编辑器
const 去注释 = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, "")).replace(/^\s*\/\/.*$/gm, "");
const HEX = /#[0-9a-fA-F]{3,8}\b/g;

function 所有源文件(dir: string): string[] {
  const out: string[] = [];
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) {
      if (n !== "generated") out.push(...所有源文件(p));
    } else if (/\.(tsx?|css)$/.test(n)) out.push(p);
  }
  return out;
}

const 放行 = new Set(["app/globals.css", "lib/palette.ts", "components/Logo.tsx"]);

describe("色值只在 :root 和 palette.ts 里写死", () => {
  it("别处一律用 token", () => {
    const 散的: string[] = [];
    for (const f of 所有源文件(根目录)) {
      const rel = path.relative(根目录, f).replaceAll("\\", "/");
      if (放行.has(rel)) continue;
      const 行 = 去注释(fs.readFileSync(f, "utf8")).split("\n");
      行.forEach((l, i) => {
        for (const m of l.match(HEX) ?? []) 散的.push(`${rel}:${i + 1} ${m}`);
      });
    }
    expect(散的, `这些地方还写着裸 hex，改成 var(--…) 或 palette.…：\n${散的.join("\n")}`).toEqual([]);
  });

  it("globals.css 里 :root 之外也不许有", () => {
    const 正文 = 去注释(css.slice(css.indexOf("\n}", css.indexOf(":root"))));
    expect(正文.match(HEX) ?? []).toEqual([]);
  });

  it("palette.ts 的每个值都在 :root 里，一字不差", async () => {
    const { palette, categorical, avatarBg } = await import("@/lib/palette");
    const 根 = 去注释(css.slice(css.indexOf(":root"), css.indexOf("\n}", css.indexOf(":root"))));
    const 根里的值 = new Set((根.match(HEX) ?? []).map((h) => h.toLowerCase()));
    const 漏了: string[] = [];
    for (const [k, v] of Object.entries({ ...palette, ...categorical })) if (!根里的值.has(v.toLowerCase())) 漏了.push(`${k}=${v}`);
    avatarBg.forEach((v, i) => { if (!根里的值.has(v.toLowerCase())) 漏了.push(`avatar[${i}]=${v}`); });
    expect(漏了, `palette.ts 里这些值 :root 没有：${漏了.join("、")}`).toEqual([]);
  });

  it("颜色总数有上限：语义色 + 八个分类色 + 八个头像色，再多就是又开始各拍各的", () => {
    const 根 = 去注释(css.slice(css.indexOf(":root"), css.indexOf("\n}", css.indexOf(":root"))));
    const 不同 = new Set((根.match(HEX) ?? []).map((h) => h.toLowerCase()));
    expect(不同.size).toBeLessThanOrEqual(48);
  });
});
