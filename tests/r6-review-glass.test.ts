/**
 * 第六轮对抗复查：毛玻璃在 Windows 上的门槛（desktop/main.js 的 玻璃可用）。
 *
 * Electron 自己的类型说明（desktop/node_modules/electron/electron.d.ts，setBackgroundMaterial 那段）：
 *   "This method is only supported on Windows 11 22H2 and up."
 * 22H2 = build 22621。main.js 的门槛是 >= 22000（21H2），21H2 上 玻璃可用=true：
 * 窗口照样按 backgroundColor "#00000000" 建、页面挂上 glass 类把底色全调成半透明，
 * 但 acrylic 根本不生效——底下没有材质。红的保持红。
 *
 * 壳是裸 JS、起不来 Electron：把那一个函数的源码抠出来，喂假的 os / process 跑。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const main = fs.readFileSync(path.resolve(__dirname, "../desktop/main.js"), "utf8");
const 源 = /function 玻璃可用\(\) \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";

function 玻璃可用(platform: string, release: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function("os", "process", `${源}; return 玻璃可用();`)({ release: () => release }, { platform });
}

describe("R6-7 Windows 11 21H2 被当成支持 acrylic", () => {
  it("抠得到函数（防止改名后这条用例假绿）", () => {
    expect(源).toContain("22000");
  });

  it("对照：22H2（22621）和 Mac 可用，Windows 10 不可用", () => {
    expect(玻璃可用("win32", "10.0.22621")).toBe(true);
    expect(玻璃可用("darwin", "24.0.0")).toBe(true);
    expect(玻璃可用("win32", "10.0.19045")).toBe(false);
  });

  it("Windows 11 21H2（build 22000）：setBackgroundMaterial 不支持，应当不开毛玻璃", () => {
    expect(玻璃可用("win32", "10.0.22000")).toBe(false);
  });
});
