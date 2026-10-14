/**
 * Windows 外观（2026-10-14）：照片里顶上一条系统蓝标题栏 + 一整行 Mac 式菜单、中文等宽字掉宋体、
 * 雅黑没有 500 层次全平、关了「显示动画」进度点就停住像卡死、浅灰字在 ClearType 下几乎看不见。
 * 这几处都是「改一边忘一边」就悄悄回来的，钉住。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const 读 = (p: string) => readFileSync(path.resolve(__dirname, "..", p), "utf8");
const css = 读("src/app/globals.css");
const main = 读("desktop/main.js");
const preload = 读("desktop/preload-app.js");
const theme = 读("src/lib/theme.ts");
const 去注释 = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

describe("Windows 标题栏", () => {
  it("不画系统标题栏，三个钮交给系统叠在右上角，高度和 --caption-h 一致", () => {
    const h = /--caption-h:\s*(\d+)px/.exec(css);
    expect(h, "--caption-h 应该在 :root 里").not.toBeNull();
    const 高 = Number(h![1]);
    expect(main).toMatch(/process\.platform === "win32" \? \{\s*titleBarStyle: "hidden",/);
    const 高们 = [...main.matchAll(/height:\s*(\d+)\s*\}/g)].map((m) => Number(m[1])).filter((n) => n < 80);
    expect(高们.length).toBeGreaterThanOrEqual(2); // 建窗口一处、setTitleBarOverlay 一处
    for (const n of 高们) expect(n).toBe(高);
  });

  it("页面在 Windows 上让出右上角那条，拖动把手就是它", () => {
    const 正文 = 去注释(css);
    expect(正文).toContain("html.os-win .shell-desktop .drag-strip { height: var(--caption-h); }");
    expect(正文).toMatch(/html\.os-win \.shell-desktop \.main \{ padding-top: calc\(var\(--caption-h\)/);
    expect(preload).toContain('classList.add("os-win")');
    expect(preload).toContain('ipcRenderer.send("shell:titlebar"');
  });

  it("主进程只收 rgb()/#hex，而且只收主窗口发来的", () => {
    const 段 = main.slice(main.indexOf('ipcMain.on("shell:titlebar"'));
    expect(段).toContain("e.sender !== win.webContents");
    expect(段).toMatch(/\^\(#\[0-9a-fA-F\]\{6\}/);
  });

  it("Windows 菜单没有「以软件名命名的应用菜单」，关于在帮助里", () => {
    expect(main).toContain("const 头两项 = isMac");
    expect(main).toContain("...关于项,");
  });
});

describe("Windows 字体", () => {
  const ui = /--font-ui:\s*([^;]+);/.exec(css)![1].trim();

  it("英文先走 Segoe UI，中文先走雅黑别名再走雅黑；Mac 的苹方仍在雅黑前面", () => {
    const 位 = (n: string) => ui.indexOf(n);
    expect(位('"Segoe UI"')).toBeGreaterThan(-1);
    expect(位('"Segoe UI"')).toBeLessThan(位('"PingFang SC"'));
    expect(位('"PingFang SC"')).toBeLessThan(位('"Daedalus YaHei"'));
    expect(位('"Daedalus YaHei"')).toBeLessThan(位('"Microsoft YaHei"'));
  });

  it("antd 主题的字体栈和 --font-ui 一字不差", () => {
    const m = /fontFamily:\s*'([^']+)'/.exec(theme);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(ui);
  });

  it("雅黑别名两档：≤450 常规，≥451 粗体（雅黑没有 500）", () => {
    const 面 = [...css.matchAll(/@font-face\s*\{[^}]*font-family:\s*"Daedalus YaHei"[^}]*\}/g)].map((m) => m[0]);
    expect(面).toHaveLength(2);
    expect(面.join("\n")).toMatch(/font-weight:\s*100 450/);
    expect(面.join("\n")).toMatch(/Bold[^}]*font-weight:\s*451 900/);
  });

  it("等宽字体只许用 --font-mono，而且它给中文留了雅黑", () => {
    const mono = /--font-mono:\s*([^;]+);/.exec(css)![1];
    expect(mono).toContain('"Microsoft YaHei"');
    const 散的 = [...去注释(css).matchAll(/font-family:\s*([^;}]*)/g)].map((m) => m[1]).filter((v) => /Menlo|Consolas|monospace/.test(v));
    expect(散的, `这些地方还写着自己的等宽字体栈：${散的.join(" | ")}`).toEqual([]);
  });
});

describe("Windows 关了「显示动画」", () => {
  it("进度点和转圈改成原地明暗呼吸，不停、不转、不挪", () => {
    const i = css.indexOf("@media (prefers-reduced-motion: reduce)");
    const 块 = css.slice(i, css.indexOf("@keyframes rd-pulse"));
    for (const sel of [".trace-dot-run", ".aiw-dot-run", ".cli-step-running .cli-dot", ".ant-spin-dot", ".anticon-spin"]) expect(块).toContain(sel);
    expect(块).toMatch(/animation: rd-pulse [^;]*infinite !important; transform: none !important;/);
    expect(css).toMatch(/@keyframes rd-pulse \{ 0%, 100% \{ opacity: [\d.]+; \} 50% \{ opacity: 1; \} \}/);
  });
});

describe("Windows 字色", () => {
  it("只压深默认主题的两档浅灰，别的主题不替它们改", () => {
    const 规则 = [...去注释(css).matchAll(/html\.os-win(\[[^\]]*\])?\s*\{([^}]*)\}/g)];
    expect(规则.length).toBe(1);
    expect(规则[0][1]).toBe('[data-skin="now"]');
    expect(规则[0][2]).toContain("--text-muted");
    expect(规则[0][2]).toContain("--text-faint");
  });
});
