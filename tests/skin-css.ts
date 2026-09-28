/**
 * 主题样式表（src/app/skins/*.css）的读法，给 skins / design-tokens / motion-tokens 三份守卫共用。
 *
 * 一个主题文件里只有两种块：
 *   token 块  选择器只是 `:root[data-skin="x"]`（可带 `[data-paper="white"]`）或 `[data-skin-preview="x"]`，
 *             块里只有 `--名字: 值;`（外加 color-scheme）。色值、曲线只许写在这里
 *   形状规则  其余的块。每套不超过 10 条
 */
import fs from "node:fs";
import path from "node:path";

export const 源 = path.resolve(__dirname, "../src");
export const 主题目录 = path.join(源, "app/skins");
export const globals = fs.readFileSync(path.join(源, "app/globals.css"), "utf8");

/** 去注释时把块注释换成同样多的换行，报出来的行号才对得上编辑器 */
export const 去注释 = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""));

export type 块 = { 选择器: string; 体: string; 起: number; 止: number; token块: boolean };

const TOKEN选择器 = /^(?::root\[data-skin="[\w-]+"\](?:\[data-paper="[\w-]+"\])?|\[data-skin-preview="[\w-]+"\])$/;

/** 只认一层的块（主题文件里不许嵌套 @media，这也是一条规矩：减弱动态只在 globals.css 里管） */
export function 拆块(css: string): 块[] {
  const s = 去注释(css);
  const out: 块[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const 选择器 = m[1].trim();
    const 体 = m[2];
    const 各选择器 = 选择器.split(",").map((x) => x.trim());
    const 只有变量 = 体
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean)
      .every((d) => d.startsWith("--") || d.startsWith("color-scheme"));
    out.push({ 选择器, 体, 起: m.index, 止: m.index + m[0].length, token块: 只有变量 && 各选择器.every((x) => TOKEN选择器.test(x)) });
  }
  return out;
}

/** 块里的 `--名字: 值`（值去掉首尾空白） */
export function 变量(体: string): Map<string, string> {
  const r = new Map<string, string>();
  for (const d of 体.split(";")) {
    const i = d.indexOf(":");
    const k = d.slice(0, i).trim();
    if (k.startsWith("--")) r.set(k, d.slice(i + 1).trim());
  }
  return r;
}

/** globals.css 第一块（:root 那块）里定义过的所有变量 */
export function 根变量(): Map<string, string> {
  const s = 去注释(globals);
  const i = s.indexOf(":root");
  return 变量(s.slice(s.indexOf("{", i) + 1, s.indexOf("\n}", i)));
}

export function 主题文件(): { key: string; 文: string }[] {
  return fs
    .readdirSync(主题目录)
    .filter((n) => n.endsWith(".css") && n !== "shared.css")
    .map((n) => ({ key: n.replace(/\.css$/, ""), 文: fs.readFileSync(path.join(主题目录, n), "utf8") }));
}
