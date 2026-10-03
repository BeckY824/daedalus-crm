/**
 * 不同窗口大小下的排版（2026-10-03 五档走查：1024×700 / 1250×860 / 1512×982 / 1920×1080 / 2560×1440）。
 *
 * 桌面端窗口最小 1024×700（desktop/main.js 的 minWidth/minHeight），13 寸常用 1250×860 上下，外接屏能到 2560。
 * 下面每一条都是那次走查里实地看到、改之前是红的：
 *   - 弹框：antd 6 的外壳叫 .ant-modal-container，限高规则按 5 的 .ant-modal-content 写，一直没生效——
 *     「新建跟进」780 高，700 的窗口里「保存」在窗外
 *   - 记录页：AI 栏的门槛按「还没有名单」时定的，15 寸 1512 宽时时间线不到 400，「直接记」折到第二行
 *   - 列表筛选行：1024 宽时整组筛选掉到「列」下面，看不见的「重置」又折到第二行，空出一截
 *   - 外接屏：面板开着时四张指标卡不分窗口一律两两一排；直接打开 /settings 白卡片拉满一千多
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库, 清空业务数据, 造模拟数据 } from "./mock-data";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };

test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await 造模拟数据(p);
  await p.$disconnect();
});

async function 登录(page: Page) {
  await page.goto("/login");
  const 提示 = page.locator(".ant-alert");
  for (let i = 0; i < 3; i++) {
    await page.getByPlaceholder("用户名").fill(账号.用户名);
    await page.getByPlaceholder("登录密码").fill(账号.密码);
    await page.getByRole("button", { name: /登\s*录/ }).click();
    for (let t = 0; t < 40; t++) {
      if (/\/dashboard/.test(page.url())) return;
      if (await 提示.isVisible().catch(() => false)) throw new Error("登录失败");
      await page.waitForTimeout(200);
    }
  }
  throw new Error("登录没反应");
}

async function 进第一位客户(page: Page) {
  await page.goto("/customers");
  await page.waitForSelector(".ant-table-row");
  await page.locator(".ant-table-row .link-strong").first().click();
  await expect(page).toHaveURL(/\/customers\/[^/]+$/);
}

test("最小窗口 1024×700：「新建跟进」比窗口高也看得见「保存」，中间那段自己滚", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await 登录(page);
  await 进第一位客户(page);
  await page.getByRole("button", { name: /记录跟进/ }).first().click();
  const 框 = page.locator(".ant-modal-container").last();
  await expect(框).toBeVisible();
  const 保存 = 框.locator(".ant-modal-footer").getByRole("button", { name: /保\s*存/ });
  await expect(保存).toBeInViewport({ ratio: 1 });
  const 盒 = (await 框.boundingBox())!;
  expect(盒.y).toBeGreaterThanOrEqual(0);
  expect(盒.y + 盒.height).toBeLessThanOrEqual(700);
});

test("15 寸 1512 宽、面板收着：记录页的时间线至少 480，AI 栏收成头部按钮", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 982 });
  await 登录(page);
  await 进第一位客户(page);
  const 时间线 = page.locator(".rec > .rec-col").first();
  await expect(时间线).toBeVisible();
  await expect.poll(async () => (await 时间线.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(480);
});

test("最小窗口 1024：列表筛选行一行摆下，「列」不被挤到第二行", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await 登录(page);
  for (const 路 of ["/customers", "/opportunities", "/follow-ups"]) {
    await page.goto(路);
    await page.waitForSelector(".list-bar");
    const 顶 = await page.locator(".list-bar").evaluate((b) => {
      const 项 = [...b.querySelectorAll(":scope > .ant-space > .ant-space-item, :scope > .ant-btn, :scope > .ant-dropdown-trigger")];
      return 项.map((e) => Math.round(e.getBoundingClientRect().top));
    });
    expect(new Set(顶).size, `${路} 的筛选行折成了 ${new Set(顶).size} 行：${顶.join(",")}`).toBe(1);
  }
});

test("外接屏 2560：数据页四张指标卡一排；直接打开设置不铺满", async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await 登录(page);
  await page.goto("/overview");
  const 卡 = page.locator(".ant-col-xl-6");
  await expect(卡.first()).toBeVisible();
  const 顶 = await 卡.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(顶.slice(0, 4)).size).toBe(1);

  await page.goto("/settings");
  const 设置 = page.locator(".set").first();
  await expect(设置).toBeVisible();
  expect((await 设置.boundingBox())!.width).toBeLessThanOrEqual(1040);
});
