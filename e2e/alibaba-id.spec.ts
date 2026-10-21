/**
 * 阿里国际站 ID（2026-10-21 客户反馈）：外贸模版下新建客户只填阿里 ID 也能存；同一个阿里 ID 再建被挡；
 * 客户详情能看能改；列表搜索框粘阿里 ID 能找到。Windows 常见的 1280 / 1366 宽下，新建框、详情页不撑破、不被切。
 * 配超长客户名一起看。跑完把预设套回通用销售。
 *
 * 截图写到 E2E_SHOT_DIR（不给就不截）
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";
import { 查排版, 说问题 } from "./layout-audit";

const 管理员 = { 用户名: "admin", 密码: "admin123" };
const 前缀 = "阿里ID测试";
const 客户名 = `${前缀}·Al Futtaim Lighting & Electrical Trading Co. L.L.C. (Dubai Investment Park Branch)`;
const 阿里ID = "ae1029384756mhdlighting";
const 截图目录 = process.env.E2E_SHOT_DIR;
const 截 = async (page: Page, 名: string) => {
  if (!截图目录) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${截图目录}/${名}.png` });
};

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
      /* dev 模式下第一次点击可能落空，再试 */
    }
  }
  throw new Error("登录失败");
}

async function 选(page: Page, 字: string | RegExp) {
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option", { hasText: 字 }).first().click();
}

async function 套预设(page: Page, 名: string) {
  await page.goto("/settings");
  await page.getByRole("tab", { name: "业务配置" }).click();
  const 面板 = page.getByRole("tabpanel", { name: "业务配置" });
  await 面板.getByRole("button", { name: 名, exact: true }).click();
  await 面板.locator(".biz-preset-todo").getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText("已保存，全站措辞已更新")).toBeVisible({ timeout: 15_000 });
}

async function 收拾() {
  const db = 连库();
  try {
    await db.customer.deleteMany({ where: { name: { startsWith: 前缀 } } });
  } finally {
    await db.$disconnect();
  }
}

/** 只管这次加的东西：阿里 ID 那一格、客户名 */
async function 量(page: Page, 范围: string) {
  const 问题 = (await 查排版(page, { 范围 })).filter((x) => /阿里|至少填一个|阿里ID测试/.test(x.字));
  expect(问题, 说问题(问题)).toEqual([]);
}

test.describe.configure({ mode: "serial", timeout: 180_000 });
test.beforeAll(收拾);
test.afterAll(async ({ browser }) => {
  await 收拾();
  const page = await browser.newPage();
  try {
    await 登录(page);
    await 套预设(page, "通用销售");
  } finally {
    await page.close();
  }
});

for (const 宽 of [1280, 1366]) {
  test(`${宽} 宽：只填阿里 ID 能建；同一个再建被挡；详情能看到；搜索能找到`, async ({ page }) => {
    const 出错: string[] = [];
    page.on("pageerror", (e) => 出错.push(e.message.slice(0, 200)));
    await page.setViewportSize({ width: 宽, height: 760 });
    await 收拾();
    await 登录(page);
    await 套预设(page, "外贸出口");

    await page.goto("/customers");
    await page.getByRole("button", { name: /新建客户/ }).click();
    const 框 = page.getByRole("dialog", { name: "新建客户" });
    await expect(框).toBeVisible();
    await expect(框.getByText("电话 / WhatsApp / 邮箱 / 微信 / 阿里 ID 至少填一个")).toBeVisible();
    await 框.getByLabel("客户姓名").fill(客户名);
    const 格 = 框.getByLabel(/^阿里国际站 ID/);
    await 格.scrollIntoViewIfNeeded();
    await 格.fill(`Buyer ID: ${阿里ID}`);
    // 管理员不能当销售负责人，挑一位
    await 框.getByLabel("销售负责人").click();
    await 选(page, "张三");
    await 量(page, ".ant-modal");
    await 截(page, `新建框-只填阿里ID-${宽}`);
    await 框.getByRole("button", { name: /保\s*存|确\s*定/ }).last().click();
    await expect(框).toBeHidden({ timeout: 15_000 });

    const db = 连库();
    const c = await db.customer.findFirstOrThrow({ where: { name: 客户名 }, include: { extra: true } });
    await db.$disconnect();
    expect(c.phone).toBe("");
    expect(c.extra?.alibabaId).toBe(阿里ID);

    // 同一个阿里 ID（大写）再建一位：被挡，说的是阿里 ID 和那位是谁
    await page.getByRole("button", { name: /新建客户/ }).click();
    await expect(框).toBeVisible();
    await 框.getByLabel("客户姓名").fill(`${前缀}·重复的`);
    await 框.getByLabel(/^阿里国际站 ID/).fill(阿里ID.toUpperCase());
    await 框.getByLabel("销售负责人").click();
    await 选(page, "张三");
    await 框.getByRole("button", { name: /保\s*存|确\s*定/ }).last().click();
    await expect(page.getByText(new RegExp(`阿里 ID ${阿里ID.toUpperCase()}`))).toBeVisible({ timeout: 15_000 });
    await 截(page, `新建框-阿里ID重复被挡-${宽}`);
    await 框.getByRole("button", { name: /取\s*消/ }).click();
    const 放弃 = page.locator(".ant-modal-confirm", { hasText: "放弃填的内容？" });
    if (await 放弃.isVisible().catch(() => false)) await 放弃.getByRole("button", { name: /放\s*弃/ }).click();

    // 列表搜索框粘阿里 ID 能找到
    await page.goto(`/customers?keyword=${阿里ID.slice(0, 12)}`);
    await expect(page.getByRole("link", { name: 客户名 }).first()).toBeVisible({ timeout: 15_000 });
    await 截(page, `列表-按阿里ID搜到-${宽}`);

    // 详情页：资料里有「阿里 ID」。字段名那一栏只有 66px、不折行，「阿里国际站 ID」放不下会被切（第一版就切了）
    await page.goto(`/customers/${c.id}`);
    const 名格 = page.locator(".rec-field-k:visible", { hasText: /^阿里 ID$/ }).first();
    await expect(名格).toBeVisible({ timeout: 15_000 });
    expect(await 名格.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(page.getByText(阿里ID).first()).toBeVisible();
    await 量(page, "main");
    await 截(page, `详情-阿里ID-${宽}`);

    expect(出错).toEqual([]);
  });
}
