import { expect, it } from "vitest";
import fs from "node:fs";
import { 摆团队项 } from "@/lib/business-config";

/**
 * 业务配置里的公海、项目模式、业务员能删客户三项（2026-10-29）：开了团队就摆，不等第二个人同步进来。
 * 以前看的是本机在职账号 > 1——老板刚开通团队、还没拉人时三项都藏着，更新记录却写「团队里才有」
 */
it("开了团队、只有自己一个人：三项也摆出来", () => {
  expect(摆团队项(true, 1)).toBe(true);
  expect(摆团队项(true, 3)).toBe(true);
  // 没开团队：照旧看本机人数（网页版 / 老库里多个账号的还摆）
  expect(摆团队项(false, 1)).toBe(false);
  expect(摆团队项(false, 2)).toBe(true);
});

it("设置页真用的是它，在团队从 .team.json 读", () => {
  const 页 = fs.readFileSync("src/app/(app)/settings/SettingsView.tsx", "utf8");
  expect(页).toMatch(/多人=\{摆团队项\(在团队/);
  const 取数 = fs.readFileSync("src/app/(app)/settings/SettingsBody.tsx", "utf8");
  expect(取数).toMatch(/在团队=\{[^}]*读团队\(\)/);
});
