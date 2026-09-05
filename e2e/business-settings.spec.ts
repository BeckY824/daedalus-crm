/**
 * 界面化配置：管理员改术语后全站同步；AI 接入页的校验。
 * 文件名以 b 开头、排在其余用例之前，跑完必须把术语改回「学员」，
 * 否则后面按文字定位的用例全部失配。
 */
import { test, expect, type Page } from "@playwright/test";

const 管理员 = { 用户名: "admin", 密码: "crm@2026" };

async function 登录(page: Page) {
  await page.goto("/login");
  for (let i = 0; i < 3; i++) {
    await page.getByPlaceholder("用户名").fill(管理员.用户名);
    await page.getByPlaceholder("登录密码").fill(管理员.密码);
    await page.getByRole("button", { name: /登\s*录/ }).click();
    for (let t = 0; t < 40; t++) {
      if (/\/dashboard/.test(page.url())) return;
      await page.waitForTimeout(200);
    }
  }
  throw new Error("登录失败");
}

/** 其余页签（修改密码、AI 接入）里也有「保存」按钮，只是隐藏着——定位必须限定在当前页签内 */
async function 打开业务配置(page: Page) {
  await page.goto("/settings");
  await page.getByRole("tab", { name: "业务配置" }).click();
  const 面板 = page.getByRole("tabpanel", { name: "业务配置" });
  await expect(面板.getByLabel("客户叫什么")).toBeVisible();
  return 面板;
}

async function 保存并等提示(page: Page, 面板: ReturnType<Page["getByRole"]>) {
  await 面板.getByRole("button", { name: /^保\s*存$/ }).click();
  await expect(page.getByText("已保存，全站措辞已更新")).toBeVisible({ timeout: 15_000 });
}

async function 改客户名词(page: Page, 名词: string) {
  const 面板 = await 打开业务配置(page);
  await 面板.getByLabel("客户叫什么").fill(名词);
  await 保存并等提示(page, 面板);
}

test.describe.serial("业务配置", () => {
  test("把「学员」改成「客户」，侧边栏、列表页标题与表头同步变；改回去后恢复", async ({ page }) => {
    await 登录(page);
    await 改客户名词(page, "客户");

    await page.goto("/customers");
    await expect(page.getByRole("link", { name: "客户管理" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "客户管理" })).toBeVisible();
    await expect(page.getByRole("button", { name: /新建客户/ })).toBeVisible();

    // 复原，后面的用例靠「学员」定位
    await 改客户名词(page, "学员");
    await page.goto("/customers");
    await expect(page.getByRole("link", { name: "学员管理" })).toBeVisible();
    await expect(page.getByRole("button", { name: /新建学员/ })).toBeVisible();
  });

  test("档案字段改名后表头跟着变，数据库列不动", async ({ page }) => {
    await 登录(page);
    let 面板 = await 打开业务配置(page);
    await 面板.getByLabel("档案字段 1").fill("公司");
    await 保存并等提示(page, 面板);

    await page.goto("/customers");
    await expect(page.getByRole("columnheader", { name: "公司" })).toBeVisible();

    面板 = await 打开业务配置(page);
    await 面板.getByLabel("档案字段 1").fill("院校");
    await 保存并等提示(page, 面板);
  });

  test("AI 接入：页签可见，接口地址格式不对会被表单拦下", async ({ page }) => {
    await 登录(page);
    await page.goto("/settings");
    await page.getByRole("tab", { name: "AI 接入" }).click();
    const 面板 = page.getByRole("tabpanel", { name: "AI 接入" });
    // dev server 会读 .env，本机可能配了 LLM_API_KEY 也可能没配——两种状态的提示都算对
    await expect(面板.locator(".ant-alert")).toBeVisible();
    await 面板.getByLabel("接口地址").fill("ftp://not-http");
    await 面板.getByRole("button", { name: /^保\s*存$/ }).click();
    await expect(面板.getByText("要以 http:// 或 https:// 开头")).toBeVisible();
  });
});
