/**
 * 客户使用反馈（2026-10-19）桌面端几条在真页面上走一遍。单测见 tests/feedback-1019.test.ts，弹窗细节见 tests/feedback-1019.ui.test.ts。
 *
 *   录入弹窗：点框外面不关；填了东西按 Esc 先问「放弃填的内容？」；「留着草稿」下次打开接着填；保存成功草稿清掉
 *   外贸新建客户：电话 / WhatsApp / 邮箱 / 微信四格同一个记号；只填微信能建；同一个微信号再建被挡
 *   跟进类型「微信沟通」：记录跟进能选、存下来是 WECHAT、时间线上显示「微信沟通」
 *
 * 模版从「设置 → 业务配置」界面切，结束切回通用销售。数据自己造自己收。
 * FB_SHOT=目录 时顺手截图（交付用）。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";

const 管理员 = { 用户名: "admin", 密码: "admin123" };
const 前缀 = "反馈1019测试";
const 只有微信 = `${前缀}·只有微信`;
const 微信号 = "fb1019_wangwei";
const 截图 = async (page: Page, 名: string) => {
  // 等下拉、提示的动画走完再截
  if (!process.env.FB_SHOT) return;
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${process.env.FB_SHOT}/${名}.png` });
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
    const ids = (await db.customer.findMany({ where: { name: { startsWith: 前缀 } }, select: { id: true } })).map((c) => c.id);
    await db.followUp.deleteMany({ where: { customerId: { in: ids } } });
    await db.customer.deleteMany({ where: { id: { in: ids } } });
  } finally {
    await db.$disconnect();
  }
}

const 问框 = (page: Page) => page.locator(".ant-modal-confirm", { hasText: "放弃填的内容？" });

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(收拾);
test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await 登录(page);
    await 套预设(page, "通用销售");
  } finally {
    await page.close();
    await 收拾();
    const db = 连库();
    await db.setting.deleteMany({ where: { key: "business" } });
    await db.$disconnect();
  }
});

test("新建客户：点外面不关；填了按 Esc 先问；留着草稿下次接着填；只填微信能存；同微信号再建被挡", async ({ page }) => {
  const 问题: string[] = [];
  page.on("pageerror", (e) => 问题.push(`[pageerror] ${e.message.slice(0, 200)}`));
  await 登录(page);
  await 套预设(page, "外贸出口");

  await page.goto("/customers");
  await page.getByRole("button", { name: /新建客户/ }).click();
  const 框 = page.getByRole("dialog", { name: "新建客户" });
  await expect(框).toBeVisible();
  // 四格（电话 / WhatsApp / 邮箱 / 微信）同一个记号，电话下面一行说规矩；电话不再单独标红星
  await expect(框.locator(".cf-any-mark")).toHaveCount(6);
  await expect(框.getByText("电话 / WhatsApp / 邮箱 / 微信 / 阿里 ID 至少填一个")).toBeVisible();
  await expect(框.locator("label[for=phone].ant-form-item-required")).toHaveCount(0);

  await 框.getByLabel("客户姓名").fill(只有微信);
  await 框.getByLabel(/^微信/).fill(微信号);
  await 截图(page, "1-新建客户-四格记号");

  // 点框外面（左上角遮罩）：不关
  await page.mouse.click(5, 300);
  await page.waitForTimeout(500);
  await expect(框).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(问框(page)).toBeVisible();
  await 截图(page, "2-放弃填的内容");
  await 问框(page).getByRole("button", { name: "留着草稿，先关掉" }).click();
  await expect(框).toBeHidden();

  // 再开：接着填
  await page.getByRole("button", { name: /新建客户/ }).click();
  await expect(框).toBeVisible();
  await expect(框.getByLabel("客户姓名")).toHaveValue(只有微信);
  await expect(框.getByLabel(/^微信/)).toHaveValue(微信号);
  await expect(page.getByText("接着上次没填完的继续填")).toBeVisible();
  await 截图(page, "3-草稿恢复");

  // 管理员不能当销售负责人，挑一位
  await 框.getByLabel("销售负责人").click();
  await 选(page, "张三");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框).toBeHidden({ timeout: 15_000 });
  const db = 连库();
  try {
    const c = await db.customer.findFirstOrThrow({ where: { name: 只有微信 }, include: { extra: true } });
    expect([c.phone, c.extra?.wechat]).toEqual(["", 微信号]);
  } finally {
    await db.$disconnect();
  }
  // 草稿清掉了：再开是空的
  await page.getByRole("button", { name: /新建客户/ }).click();
  await expect(框).toBeVisible();
  await page.waitForTimeout(500);
  await expect(框.getByLabel("客户姓名")).toHaveValue("");

  // 四样都不填：说规矩，不交
  await 框.getByLabel("客户姓名").fill(`${前缀}·什么都没有`);
  await 框.getByLabel("销售负责人").click();
  await 选(page, "张三");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框.locator(".ant-form-item-explain-error", { hasText: "电话 / WhatsApp / 邮箱 / 微信 / 阿里 ID 至少填一个" })).toBeVisible();
  // 报错时下面那行同样的提示收起来，不说两遍
  await expect(框.locator(".cf-any-hint")).toBeHidden();
  await 截图(page, "4-四样至少填一个");

  // 同一个微信号（大小写不同）：服务端挡下，说的是微信
  await 框.getByLabel("客户姓名").fill(`${前缀}·撞微信`);
  await 框.getByLabel(/^微信/).fill(微信号.toUpperCase());
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText(new RegExp(`微信 ${微信号.toUpperCase()} 已存在`))).toBeVisible();
  await expect(框).toBeVisible();

  // 放弃：关掉
  await 框.getByRole("button", { name: /取\s*消/ }).click();
  await 问框(page).getByRole("button", { name: /^放\s*弃$/ }).click();
  await expect(框).toBeHidden();
  expect(问题).toEqual([]);
});

test("记录跟进：类型能选「微信沟通」，存下来是 WECHAT，时间线上写「微信沟通」", async ({ page }) => {
  await 登录(page);
  const db = 连库();
  const c = await db.customer.findFirstOrThrow({ where: { name: 只有微信 } });
  await db.$disconnect();
  await page.goto(`/customers/${c.id}`);
  await page.getByRole("button", { name: "记录跟进" }).click();
  const 框 = page.getByRole("dialog");
  await 框.getByLabel("跟进类型").click();
  await 选(page, "微信沟通");
  await 框.getByLabel("沟通内容").fill("微信上发了目录和报价");
  await 截图(page, "5-微信沟通跟进");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框).toBeHidden({ timeout: 15_000 });
  const db2 = 连库();
  try {
    expect(await db2.followUp.findFirstOrThrow({ where: { customerId: c.id } })).toMatchObject({ type: "WECHAT", content: "微信上发了目录和报价" });
  } finally {
    await db2.$disconnect();
  }
  await expect(page.getByRole("main").getByText("微信沟通").first()).toBeVisible();
});
