/**
 * 首页「近期跟进任务」长标题 / 长客户名（10-24）：两行都用 globals.css 的 .clamp-1 收成一行省略，
 * 被截掉的悬停能看全（title 带完整文字）。客户名原来是光秃秃的链接，无空格长名会把卡片撑出去。
 * 屏幕上量不量得出来交给排版闸门（e2e-layout 首页，种子里有长计划名 + 无空格客户名），这里钉源码别被改回去。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/app/(app)/dashboard/DashboardView.tsx", import.meta.url), "utf8");

describe("首页近期跟进任务：一行省略 + 悬停看全", () => {
  it("任务标题用 .clamp-1，title 是完整标题", () => {
    expect(src).toMatch(/className="clamp-1" title=\{t\.title\}/);
  });
  it("客户名外面包一层 .clamp-1，title 是完整客户名", () => {
    expect(src).toMatch(/className="clamp-1" title=\{t\.customerName\}>\s*<RowLink href=\{`\/customers\/\$\{t\.customerId\}`\}/);
  });
  it(".clamp-1 在 globals.css 里确实有定义", () => {
    const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.clamp-1\s*\{/);
  });
});
