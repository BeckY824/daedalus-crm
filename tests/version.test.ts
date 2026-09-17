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

const 读JSON = (p: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", p), "utf8"));

describe("版本号", () => {
  it("根包和桌面端包对得上", () => {
    const 读 = (p: string) => 读JSON(p).version as string;
    const 根 = 读("package.json");
    expect(根).toMatch(/^\d+\.\d+\.\d+$/);
    expect(读("desktop/package.json"), "改版本号时两个 package.json 要一起改").toBe(根);
    expect(读("package-lock.json")).toBe(根);
  });

  /**
   * 锁文件里**不能有第三方包的版本号等于应用版本号**。
   *
   * 这条钉的是 2026-09-17 那次 CI 全红：`chore: 0.28.0` / `chore: 0.29.0` 两次
   * 改版本号是把旧版本号在锁文件里全文替换，而 `node_modules/scheduler` 的真实版本
   * 恰好就是当时的应用版本 `0.27.0`，于是它跟着被改了两次。react-dom 要 `^0.27.0`，
   * 锁文件里写着 0.29.0，`npm ci` 当场拒绝——CI、镜像、桌面包三个 workflow 一起挂。
   *
   * 本地完全看不出来：`npm run dev` 和 `npm test` 用的是已经装好的 node_modules，
   * 只有干净环境的 `npm ci` 才会说话。所以把它钉在单测里，推之前就红。
   *
   * 改版本号请用 `node scripts/bump-version.mjs <新版本>`，它只动该动的四处。
   * 万一哪天真有个依赖的版本号和应用版本撞上，这条会误报——那时确认它在锁文件里
   * 确实是这个版本（`npm ci --dry-run` 不报错），再把它加进下面的白名单。
   */
  it("锁文件里没有被版本号替换误伤的依赖", () => {
    const 应用版本 = 读JSON("package.json").version as string;
    const 白名单 = new Set<string>();
    for (const lock of ["package-lock.json", "desktop/package-lock.json"]) {
      const packages = 读JSON(lock).packages as Record<string, { version?: string }>;
      const 撞上的 = Object.entries(packages)
        .filter(([名]) => 名 !== "" && !白名单.has(名))
        .filter(([, v]) => v.version === 应用版本)
        .map(([名]) => 名);
      expect(
        撞上的,
        `${lock} 里这些依赖的版本号等于应用版本 ${应用版本}，多半是改版本号时被全文替换误伤了；` +
          "用 scripts/bump-version.mjs 改版本号",
      ).toEqual([]);
    }
  });
});
