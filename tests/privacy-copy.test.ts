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
});
