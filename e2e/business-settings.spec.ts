/**
 * 界面化配置：管理员改术语后全站同步；AI 接入页的校验。
 * 文件名以 b 开头、排在其余用例之前，跑完必须把术语改回「学员」，
 * 否则后面按文字定位的用例全部失配。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";

const 管理员 = { 用户名: "admin", 密码: "admin123" };

/**
 * dev 模式下页面可能还没水合，第一次点击会落空，所以最多试三次；
 * 成功的判据是等到跳转完成，而不是轮询 URL——CI 的机器慢，跳转本身可能就要十几秒。
 */
async function 登录(page: Page) {
  for (let i = 0; i < 3; i++) {
    await page.goto("/login");
    await page.getByPlaceholder("用户名").fill(管理员.用户名);
    await page.getByPlaceholder("登录密码").fill(管理员.密码);
    await page.getByRole("button", { name: /登\s*录/ }).click();
    try {
      await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
      return;
    } catch {
      /* 再试 */
    }
  }
  throw new Error("登录失败");
}

/** 别的分类里也有「保存」按钮，所以定位必须限定在当前这一栏里（批 4 起只渲染选中的那一栏，
 *  但限定这件事不该依赖「另一栏恰好没渲染」） */
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

/** 库里至少有一位学员。已经有就什么都不做——这一组和别的用例共用一个库 */
async function 确保有一位学员(page: Page) {
  const db = 连库();
  try {
    if (await db.customer.count()) return;
    const owner = await db.user.findFirstOrThrow({ where: { active: true } });
    await db.customer.create({
      data: { name: "筛选栏占位", phone: "13700000001", salesOwnerId: owner.id, channelOwnerId: owner.id },
    });
  } finally {
    await db.$disconnect();
  }
  await page.goto("/customers");
}

async function 改客户名词(page: Page, 名词: string) {
  const 面板 = await 打开业务配置(page);
  await 面板.getByLabel("客户叫什么").fill(名词);
  await 保存并等提示(page, 面板);
}

/**
 * 不管这组怎么退出都把业务配置清回默认。
 *
 * 改名是写进库的，而这一组和后面所有用例共用同一个库。原来只在用例最后一步改回去——
 * 中途失败就改不回来了，于是「已试听」留成「已体验」，后面按文字定位的用例跟着一片红。
 * 2026-09-16 真发生过：business-settings 挂一条，multiuser 的批量菜单也跟着挂，
 * 排查时看起来像两个 bug。直接删 Setting 行而不是走界面——页面这时候可能已经是坏的。
 */
test.afterAll(async () => {
  const db = 连库();
  await db.setting.deleteMany({ where: { key: "business" } });
  await db.$disconnect();
});

test.describe.serial("业务配置", () => {
  test("把「学员」改成「客户」，侧边栏、列表页标题与表头同步变；改回去后恢复", async ({ page }) => {
    await 登录(page);
    await 改客户名词(page, "客户");

    await page.goto("/customers");
    // 页面标题是名词本身（批 2）：产品里这一页就叫「客户」，
    // 「客户管理：统一管理客户信息」那种是方案里的措辞，不是界面上的话。
    // 侧边栏那一条也是名词本身（2026-09-17）：「管理」两个字每一项都有，等于每一项都没有
    await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "客户", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "客户", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /新建客户/ })).toBeVisible();

    // 复原，后面的用例靠「学员」定位
    await 改客户名词(page, "学员");
    await page.goto("/customers");
    await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "学员", exact: true })).toBeVisible();
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

  /**
   * 整套措辞换成另一个行业，一次全走完。
   *
   * 上面两条各验一处（名词、一个字段名），而真正要回答的问题是
   * 「一家外贸公司拿这套 CRM 能不能用」——那要求名词、三个档案字段、字段的选项
   * 同时换掉，且换完每一页都对得上，数据库一列不动。2026-09-17 用户问到这条，
   * 而当时没有任何一条用例把它整条走过。
   */
  test("整套换成外贸的说法：客户 / 公司 / 国家 / 产品，各页跟着变，数据不动", async ({ page }) => {
    await 登录(page);
    await 确保有一位学员(page);

    let 面板 = await 打开业务配置(page);
    /* 按表单 id 定位：「档案字段 2」这个名字同时属于那个输入框和它下面的「…的选项」下拉 */
    await 面板.locator("#customer").fill("客户");
    await 面板.locator("#fields_school").fill("公司");
    await 面板.locator("#fields_grade").fill("国家");
    await 面板.locator("#fields_major").fill("产品");
    await 保存并等提示(page, 面板);

    // 列表页：标题、主按钮、三个表头
    await page.goto("/customers");
    await expect(page.getByRole("heading", { name: "客户", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /新建客户/ })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "公司" })).toBeVisible();

    // 新建表单里三个字段也要是新名字——表头改了而表单没改，人填的时候就对不上了
    await page.getByRole("button", { name: /新建客户/ }).click();
    const 表单 = page.getByRole("dialog");
    for (const 名 of ["公司", "国家", "产品"]) {
      await expect(表单.locator(".ant-form-item-label", { hasText: 名 }).first()).toBeVisible();
    }
    await 表单.getByRole("button", { name: /^取\s*消$/ }).click();

    // 数据库列没动：改名词之前就有的那条记录照常读得出来
    await expect(page.locator("main .ant-table-tbody tr").first()).toBeVisible({ timeout: 15_000 });

    // 复原，后面的用例靠默认措辞定位
    面板 = await 打开业务配置(page);
    await 面板.locator("#customer").fill("学员");
    await 面板.locator("#fields_school").fill("院校");
    await 面板.locator("#fields_grade").fill("年级");
    await 面板.locator("#fields_major").fill("专业");
    await 保存并等提示(page, 面板);
    await page.goto("/customers");
    await expect(page.getByRole("heading", { name: "学员", exact: true })).toBeVisible();
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

test.describe.serial("状态显示名", () => {
  test("把「已试听」显示为「已体验」：筛选下拉与批量菜单跟着变，存储值不变；改回去后恢复", async ({ page }) => {
    await 登录(page);
    let 面板 = await 打开业务配置(page);
    await 面板.getByLabel("已试听", { exact: true }).fill("已体验");
    await 保存并等提示(page, 面板);

    // 学员页空库时筛选栏是收起来的（对着空表摆 5 个下拉没意义），所以先确保有一条。
    // 这条用例要验的是「改了显示名，筛选下拉跟着变」，和空态无关。
    await 确保有一位学员(page);

    await page.goto("/customers");
    // antd Select 的占位文字不可点，点它所在的选择框
    const 状态筛选 = page.locator(".ant-select").filter({ hasText: "全部跟进状态" });
    await 状态筛选.click();
    // antd 的下拉项是 div，不带 option 角色，按类名找
    const 选项 = page.locator(".ant-select-dropdown .ant-select-item-option-content");
    await expect(选项.filter({ hasText: /^已体验$/ })).toBeVisible();
    await expect(选项.filter({ hasText: /^已试听$/ })).toHaveCount(0);
    await page.keyboard.press("Escape");

    面板 = await 打开业务配置(page);
    await 面板.getByLabel("已试听", { exact: true }).clear();
    await 保存并等提示(page, 面板);
    await page.goto("/customers");
    await page.locator(".ant-select").filter({ hasText: "全部跟进状态" }).click();
    await expect(page.locator(".ant-select-dropdown .ant-select-item-option-content").filter({ hasText: /^已试听$/ })).toBeVisible();
  });
});
