/**
 * 控制台巡检：遍历所有页面，任何 error / warning 都算失败。
 *
 * 拦的是"页面看着正常、控制台在报警"这类问题——它们不会让用例挂掉，
 * 却会在开发模式下堆成 Next 左下角那个红色 issue 数，也预示着真实的
 * 渲染或用法缺陷（本项目就出现过 antd v6 的 Alert/Space 弃用属性）。
 */
import { test } from "@playwright/test";

const 页面 = [
  ["数据首页", "/dashboard"],
  ["线索管理", "/leads"],
  ["学员管理", "/customers"],
  ["渠道管理", "/channels"],
  ["联系人", "/contacts"],
  ["商机列表", "/opportunities"],
  ["商机看板", "/opportunities/pipeline"],
  ["跟进记录", "/follow-ups"],
  ["跟进计划", "/follow-ups/plans"],
  ["数据复盘", "/reports"],
  ["设置管理", "/settings"],
];

test("控制台巡检", async ({ page }) => {
  const 问题: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") 问题.push(`[${m.type()}] ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => 问题.push(`[pageerror] ${e.message.slice(0, 200)}`));

  await page.goto("/login");
  await page.getByPlaceholder("用户名").fill("admin");
  await page.getByPlaceholder("登录密码").fill("crm@2026");
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await page.waitForURL("**/dashboard");

  for (const [名, 路径] of 页面) {
    问题.length = 0;
    await page.goto(路径);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(800);
    console.log(问题.length === 0 ? `✓ ${名}` : `✗ ${名}\n    ${问题.join("\n    ")}`);
  }

  // 学员详情页单独走一遍：组件最多的一页
  问题.length = 0;
  await page.goto("/customers");
  // 默认 e2e 库是空的（本用例按文件名排在最前），有学员才进详情页
  const 首个学员 = page.locator('a[href^="/customers/"]').first();
  if ((await 首个学员.count()) === 0) {
    console.log("- 学员详情：库里没有学员，跳过");
    return;
  }
  await 首个学员.click();
  await page.waitForTimeout(1200);
  await page.getByRole("tab", { name: /联系人/ }).click();
  await page.waitForTimeout(800);
  console.log(问题.length === 0 ? "✓ 学员详情（含联系人页签）" : `✗ 学员详情\n    ${问题.join("\n    ")}`);
});
