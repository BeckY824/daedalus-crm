/**
 * 中栏收起 / 打开（2026-10-19 用户定的方案，见 lib/middle-pane.ts、components/PaneToggle.tsx）。
 *
 *   记录页名单、首页对话列表：页头右边那颗收起 → 中栏不在、主区出现同一颗 → 点开回来
 *   人自己收的刷新后还收着；⌘\ / Ctrl+\ 切换；窗口太窄自动成抽屉，拉宽自己回来，人收的不回来
 *   名单收着时 ⌘K「换一位」打开名单抽屉、光标进搜索框；对话列表往窄拖过头就收起
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";
import { 装个假模型, 拆掉假模型 } from "./fake-llm";

const 前缀 = "中栏开关测试";
let 客户id = "";

async function 登录(page: Page) {
  for (let i = 0; i < 3; i++) {
    await page.goto("/login");
    await page.getByPlaceholder("用户名").fill("admin");
    await page.getByPlaceholder("登录密码").fill("admin123");
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

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async ({ browser }) => {
  const db = 连库();
  try {
    await db.customer.deleteMany({ where: { name: { startsWith: 前缀 } } });
    const 我 = await db.user.findFirstOrThrow({ where: { email: "zhangsan" } });
    客户id = (await db.customer.create({ data: { name: `${前缀}·王建国`, phone: "8613800004321", salesOwnerId: 我.id } })).id;
  } finally {
    await db.$disconnect();
  }
  await 装个假模型(browser);
});

test.afterAll(async ({ browser }) => {
  await 拆掉假模型(browser);
  const db = 连库();
  await db.customer.deleteMany({ where: { name: { startsWith: 前缀 } } });
  await db.$disconnect();
});

const 切换键 = "ControlOrMeta+Backslash";

test("记录页名单：收起、打开、刷新后保持、快捷键、窄窗口抽屉、⌘K 换一位", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await 登录(page);
  await page.goto(`/customers/${客户id}`);
  const 名单 = page.locator("aside.pane-roster");
  const 主区开关 = page.getByRole("main").getByRole("button", { name: /^显示.+名单$/ });
  await expect(名单).toBeVisible();
  await expect(主区开关).toHaveCount(0);

  // 页头右边那颗：收起
  const 收 = 名单.getByRole("button", { name: /^隐藏.+名单$/ });
  await expect(收).toHaveAttribute("aria-expanded", "true");
  await 收.click();
  await expect(名单).toHaveCount(0);
  await expect(主区开关).toBeVisible();
  await expect(主区开关).toHaveAttribute("aria-expanded", "false");

  // 刷新：还收着
  await page.reload();
  await expect(主区开关).toBeVisible();
  await expect(名单).toHaveCount(0);

  // 收着时 ⌘K「换一位」：名单抽屉打开、光标进搜索框
  await page.keyboard.press("ControlOrMeta+k");
  const 抽屉 = page.getByRole("dialog").filter({ has: page.getByRole("tablist", { name: /名单$/ }) });
  await expect(抽屉).toBeVisible();
  await expect(抽屉.getByRole("textbox", { name: /^搜索/ })).toBeFocused();
  await 抽屉.getByRole("button", { name: /^隐藏.+名单$/ }).click();
  await expect(抽屉).toBeHidden();
  await expect(名单).toHaveCount(0);

  // 主区那颗：打开
  await 主区开关.click();
  await expect(名单).toBeVisible();
  await expect(主区开关).toHaveCount(0);

  // 快捷键来回切
  await page.locator("body").click({ position: { x: 900, y: 600 } });
  await page.keyboard.press(切换键);
  await expect(名单).toHaveCount(0);
  await page.keyboard.press(切换键);
  await expect(名单).toBeVisible();

  // 窗口太窄：自动收成抽屉，同一颗开抽屉；拉宽回来名单自己回来
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(名单).toHaveCount(0);
  await 主区开关.click();
  await expect(抽屉).toBeVisible();
  // 抽屉开着时主区那颗说的是「隐藏…」
  await expect(page.locator(".rec-head .pane-toggle")).toHaveAttribute("aria-expanded", "true");
  await 抽屉.getByRole("button", { name: /^隐藏.+名单$/ }).click();
  await expect(抽屉).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(名单).toBeVisible();

  // 人自己收的：窄了再宽回来，还收着
  await 名单.getByRole("button", { name: /^隐藏.+名单$/ }).click();
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(名单).toHaveCount(0);
  await expect(主区开关).toBeVisible();
  await 主区开关.click();
  await expect(名单).toBeVisible();
});

test("首页对话列表：收起、打开、刷新后保持、快捷键、窄窗口抽屉、往窄拖过头收起", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await 登录(page);
  await page.goto("/dashboard");
  const 列表 = page.locator("aside.pane-chat");
  const 主区开关 = page.getByRole("button", { name: "显示对话列表" });
  await expect(列表).toBeVisible();
  await expect(主区开关).toHaveCount(0);

  await 列表.getByRole("button", { name: "隐藏对话列表" }).click();
  await expect(列表).toHaveCount(0);
  await expect(主区开关).toBeVisible();
  await page.reload();
  await expect(主区开关).toBeVisible();
  await expect(列表).toHaveCount(0);

  await 主区开关.click();
  await expect(列表).toBeVisible();
  await page.keyboard.press(切换键);
  await expect(列表).toHaveCount(0);
  await page.keyboard.press(切换键);
  await expect(列表).toBeVisible();

  // 窄窗口：抽屉
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(列表).toHaveCount(0);
  await 主区开关.click();
  const 抽屉 = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "新建对话" }) });
  await expect(抽屉).toBeVisible();
  await expect(抽屉.getByRole("button", { name: "新建对话" })).toBeVisible();
  await 抽屉.getByRole("button", { name: "隐藏对话列表" }).click();
  await expect(抽屉).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(列表).toBeVisible();

  // 拖缝：往窄拖过最窄值再拖一段，松手收起；宽度不被记成最窄
  const 缝 = 列表.locator(".rail-resizer[data-ready]");
  const 框 = (await 缝.boundingBox())!;
  const 原宽 = (await 列表.boundingBox())!.width;
  await page.mouse.move(框.x + 框.width / 2, 框.y + 200);
  await page.mouse.down();
  await page.mouse.move(框.x - 150, 框.y + 200, { steps: 6 });
  await page.mouse.up();
  await expect(列表).toHaveCount(0);
  await 主区开关.click();
  await expect(列表).toBeVisible();
  expect(Math.abs((await 列表.boundingBox())!.width - 原宽)).toBeLessThanOrEqual(1);
});
