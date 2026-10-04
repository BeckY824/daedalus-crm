/**
 * 设置 → 桌面端 / 团队：只在本地模式有的两栏。
 *
 * 这里跑的是「壳的桥不在」的情形（没有 Electron，window.desktopShell / desktopUpdate / desktopReminders 都没有）：
 * 正是用户在浏览器里打开本地服务、或者老壳配新服务时的样子。要求：整栏照常画出来，
 * 要靠壳的按钮灰掉，不报错、不白屏。
 */
import { test, expect } from "@playwright/test";
import { 云端账号 } from "./env";
import { 云端统计, 盯控制台, 进门 } from "./helpers";

test("设置 → 桌面端：云端账号和余额（问的是云端），壳的按钮因为桥不在而灰掉，控制台干净", async ({ page }) => {
  const 问题 = 盯控制台(page);
  await 进门(page, "/settings?tab=desktop");
  const 栏 = page.getByRole("tabpanel", { name: /^桌面端/ });
  await expect(栏).toContainText(`已登录：${云端账号.contact}`);
  // 余额是去云端问的（/api/gateway/v1/credits）：前面的用例点过一次「生成简报」，所以不写死几次
  await expect(栏).toContainText(/AI 免费次数还剩 \d+ 次/);
  expect((await 云端统计(page))["/api/gateway/v1/credits"] ?? 0).toBeGreaterThan(0);

  for (const 名 of ["备份数据库…", "打开数据文件夹", "查看服务日志", "检查更新", "复制诊断信息"]) {
    await expect(栏.getByRole("button", { name: 名 }), 名).toBeDisabled();
  }
  // 不靠壳的照常能点
  await expect(栏.getByRole("button", { name: "退出登录" })).toBeEnabled();
  await expect(栏.getByRole("button", { name: "反馈问题" })).toBeEnabled();
  // 桌面端只有云端账号这一套身份：不摆「登录与密码」「团队成员」
  const 分类 = page.getByRole("tablist", { name: "设置分类" });
  await expect(分类.getByRole("tab", { name: /^登录与密码/ })).toHaveCount(0);
  await expect(分类.getByRole("tab", { name: /^团队成员/ })).toHaveCount(0);

  await page.waitForTimeout(1000);
  expect(问题).toEqual([]);
});

test("设置 → 团队：没进团队时画出「建团队」「加入团队」两个入口", async ({ page }) => {
  const 问题 = 盯控制台(page);
  await 进门(page, "/settings?tab=team");
  const 栏 = page.getByRole("tabpanel", { name: /^团队/ });
  await expect(栏).toBeVisible();
  // 两个按钮在填了团队名 / 邀请码之前是灰的
  await expect(栏.getByRole("button", { name: /建团队/ })).toBeDisabled();
  await expect(栏.getByRole("button", { name: /加入团队/ })).toBeDisabled();
  await page.waitForTimeout(1000);
  expect(问题).toEqual([]);
});
