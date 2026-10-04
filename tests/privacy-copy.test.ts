/**
 * 界面上关于「数据去哪」的话不许说错（2026-10-04，回归核对 J-069）。
 * 粘贴面板原来写「文本不传给我们，只发给你自己配的那个模型」——桌面端 AI 默认走我们的模型网关，这句是假的。
 * 网关不存内容（只记次数和哈希），但「不传给我们」不成立。说错的隐私承诺比不说更糟，钉住这几句不许回来。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

function* 源文件(d: string): Generator<string> {
  for (const f of readdirSync(d)) {
    if (f === "generated") continue;
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) yield* 源文件(p);
    else if (/\.(ts|tsx)$/.test(f)) yield p;
  }
}

const 不许说 = ["文本不传给我们", "只发给你自己配的那个模型"];

describe("隐私说法", () => {
  it("界面源码里没有说错的「不传给我们」", () => {
    const 命中: string[] = [];
    for (const f of 源文件(path.resolve(__dirname, "../src"))) {
      const s = readFileSync(f, "utf8");
      for (const 句 of 不许说) if (s.includes(句)) 命中.push(`${path.relative(path.resolve(__dirname, ".."), f)}：${句}`);
    }
    expect(命中).toEqual([]);
  });

  /*
    桌面端的「反馈问题」不许再开公开的 GitHub issue（2026-10-04，D-106）：菜单那条原来预填了带系统用户名的本机数据路径，
    用户一点提交就公开了。现在菜单和设置页都叫开应用内反馈框（FeedbackButton 的 反馈事件）。
    自部署网页版的反馈键去 GitHub 是对的（那是开源项目的 issue），不在这条管的范围里
  */
  it("桌面端菜单和设置 → 桌面端不开公开的 GitHub issue", () => {
    for (const f of ["desktop/main.js", "src/app/(app)/settings/DesktopTab.tsx"]) {
      expect(readFileSync(path.resolve(__dirname, "..", f), "utf8"), f).not.toMatch(/github\.com\/[^"'`\s]+\/issues\/new/);
    }
    expect(readFileSync(path.resolve(__dirname, "../desktop/main.js"), "utf8")).toContain('new Event("feedback:open")');
    // 两边的事件名得是同一个，不然菜单点了没反应也不报错
    expect(readFileSync(path.resolve(__dirname, "../src/components/FeedbackButton.tsx"), "utf8")).toContain('export const 反馈事件 = "feedback:open"');
  });
});

/*
  H-094：托管版服务器在阿里云香港，隐私政策原来写「数据存放在境内」。法律文本说错比界面说错更伤——
  改成「阿里云的云服务器上」之后钉住，别哪次改文案又顺手写回「境内」
*/
describe("隐私政策：数据存放地说实情（H-094）", () => {
  it("隐私政策页不说「境内」，说的是阿里云的云服务器", () => {
    const s = readFileSync(path.resolve(__dirname, "../src/app/privacy/page.tsx"), "utf8");
    expect(s).not.toMatch(/境内/);
    expect(s).toContain("数据存放在阿里云的云服务器上");
  });
});
