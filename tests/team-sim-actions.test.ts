import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { 动作 } from "../scripts/team-sim/actions.mjs";

/**
 * 团队版五台实测（npm run test:team，2026-10-04 上线前测试 4.1）按「文件 + 导出名」去构建产物里找 Server Action。
 * 那条命令要起 6 个服务、平常没人跑；这里在 vitest 里先钉住：每个动作还在那个文件里、还是 Server Action。
 */
describe("团队版五台实测用到的 Server Action 都还在", () => {
  for (const [叫法, 键] of Object.entries(动作 as Record<string, string>)) {
    it(`${叫法}：${键}`, () => {
      const [文件, 导出名] = 键.split("#");
      const 源 = fs.readFileSync(path.resolve(__dirname, "..", 文件), "utf8");
      expect(源.trimStart().startsWith('"use server"')).toBe(true);
      expect(源).toMatch(new RegExp(`export (async )?function ${导出名}\\(`));
    });
  }
});
