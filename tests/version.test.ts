/**
 * 根 package.json 和 desktop/package.json 的版本号必须一致。
 *
 * 它们是两个包，但打的是**同一个 tag**：`v0.17.1` 一推，CI 既构建服务端镜像
 * （版本取自 tag），也用 electron-builder 打桌面包（版本取自 desktop/package.json）。
 * 两边对不上时不会有任何报错，只会出现一个叫 `Daedalus.CRM-0.16.0-arm64.dmg`
 * 的文件挂在 v0.17.1 的 Release 下面——而装上它的人，应用内报的版本也是 0.16.0，
 * 于是「检查更新」会永远告诉他有新版。真发生过，就在加这条之前。
 *
 * **这条测试管不到 tag。** 它只校验三个文件彼此一致——2026-09-16 三个文件都是
 * 0.22.0（本条全绿），但 tag 打成了 v0.22.1，症状和上面描述的一模一样。
 * 「版本号和 tag 对不对得上」挡在 CI 里：.github/workflows/{desktop,release}.yml
 * 的「版本号要和 tag 对得上」那一步，在几分钟的构建开始前就失败。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("版本号", () => {
  it("根包和桌面端包对得上", () => {
    const 读 = (p: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", p), "utf8")).version as string;
    const 根 = 读("package.json");
    expect(根).toMatch(/^\d+\.\d+\.\d+$/);
    expect(读("desktop/package.json"), "改版本号时两个 package.json 要一起改").toBe(根);
    expect(读("package-lock.json")).toBe(根);
  });
});
