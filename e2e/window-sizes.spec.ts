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
import { 装个假模型, 拆掉假模型 } from "./fake-llm";

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

/*
  2026-10-04 回归核对：下面几条也是窗口大小那一类，修了没钉
    J-203 客户详情窗口不够宽时「待办」「下次跟进」要滚到底才看见（0.46.15 挪到跟进记录上面）
    J-202 1120 宽时客户表最右一列被固定的操作列压住
    J-207 弹框钉在离顶 100px（窗口越高越偏上）；设置浮层切长栏时整层蹿高
*/
test("J-203：15 寸 1512×900 打开记录页，不用滚就看得见「下次跟进」和「待办」", async ({ page }) => {
  const p = 连库();
  const 我 = await p.user.findFirstOrThrow({ where: { email: 账号.用户名 } });
  const c = await p.customer.create({ data: { name: "待办在上面", phone: "13900005151", salesOwnerId: 我.id } });
  await p.followPlan.create({ data: { customerId: c.id, ownerId: 我.id, subject: "谈续费", plannedAt: new Date(Date.now() + 86400_000) } });
  await p.task.create({ data: { customerId: c.id, ownerId: 我.id, title: "寄合同样本" } });
  // 跟进记录多到一屏放不下：原来待办排在它们后面
  await p.followUp.createMany({
    data: Array.from({ length: 12 }, (_, i) => ({ customerId: c.id, ownerId: 我.id, type: "PHONE", title: `第 ${i + 1} 通`, content: "聊了聊近况，约了下次再细谈方案和价格", status: "已完成", occurredAt: new Date(Date.now() - (i + 1) * 3600_000) })),
  });
  try {
    await page.setViewportSize({ width: 1512, height: 900 });
    await 登录(page);
    await page.goto(`/customers/${c.id}`);
    await expect(page.getByRole("heading", { name: "待办在上面" })).toBeVisible();
    // 第一帧按视口断点排（三栏），量到正文宽度之后才换成两栏——要看的是换完之后的样子
    await expect(page.locator(".rec").first()).toHaveClass(/rec-2col/);
    await page.waitForTimeout(300);
    await expect(page.locator(".rec-plan")).toBeInViewport();
    await expect(page.locator(".rec-side-t", { hasText: "待办" })).toBeInViewport();
    await expect(page.getByText("寄合同样本")).toBeInViewport();
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  } finally {
    await p.customer.delete({ where: { id: c.id } });
    await p.$disconnect();
  }
});

test("J-202：1120 宽客户表滚到最右，最后一列不被固定的操作列压住", async ({ page }) => {
  await page.setViewportSize({ width: 1120, height: 800 });
  await 登录(page);
  await page.goto("/customers");
  await page.waitForSelector(".ant-table-row");
  // 「列」里能勾的都勾上，表格一定比窗口宽
  await page.getByRole("button", { name: "列" }).click();
  const 菜单 = page.locator(".ant-dropdown:not(.ant-dropdown-hidden)");
  await 菜单.waitFor({ state: "visible" });
  const 没勾的 = 菜单.locator(".ant-checkbox-wrapper:not(.ant-checkbox-wrapper-checked)");
  for (let n = await 没勾的.count(); n > 0; n = await 没勾的.count()) await 没勾的.first().click();
  await page.getByRole("button", { name: "列" }).click();
  await expect(菜单).toBeHidden();
  const 表 = page.locator("main .ant-table").first();
  const 滚 = 表.locator(".ant-table-content, .ant-table-body").first();
  expect(await 滚.evaluate((el) => el.scrollWidth > el.clientWidth + 10), "列全勾上了表格还没比窗口宽——这条测了个寂寞").toBe(true);
  await 滚.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await page.waitForTimeout(300);
  const 量 = await 表.evaluate((t) => {
    const 头 = [...t.querySelectorAll<HTMLElement>("thead th")].filter((th) => th.getBoundingClientRect().width > 0);
    const 固定 = 头.filter((th) => th.classList.contains("ant-table-cell-fix-right") || th.classList.contains("ant-table-cell-fix-end"));
    const 普通 = 头.filter((th) => !固定.includes(th) && !th.classList.contains("ant-table-selection-column"));
    const 末 = 普通[普通.length - 1].getBoundingClientRect();
    const 操作 = 固定.length ? Math.min(...固定.map((th) => th.getBoundingClientRect().left)) : Infinity;
    return { 末列右边: Math.round(末.right), 操作列左边: Math.round(操作), 末列: 普通[普通.length - 1].textContent };
  });
  expect(量.末列右边, `最后一列「${量.末列}」右边 ${量.末列右边}，操作列左边 ${量.操作列左边}`).toBeLessThanOrEqual(量.操作列左边 + 1);
});

test("J-207：弹框在高窗口里上下居中，不钉在离顶 100px", async ({ page }) => {
  await 登录(page);
  for (const 高 of [800, 1300]) {
    await page.setViewportSize({ width: 1440, height: 高 });
    await page.goto("/customers");
    await page.getByRole("button", { name: /新建客户/ }).click();
    const 框 = page.locator(".ant-modal-container").last();
    await expect(框).toBeVisible();
    await page.waitForTimeout(400); // 进场动画缩放走完
    const 盒 = (await 框.boundingBox())!;
    const 上 = 盒.y;
    const 下 = 高 - (盒.y + 盒.height);
    expect(Math.abs(上 - 下), `窗口高 ${高}：上空 ${Math.round(上)}，下空 ${Math.round(下)}`).toBeLessThanOrEqual(4);
    await page.keyboard.press("Escape");
    await expect(框).toBeHidden();
  }
});

test("J-207：设置浮层切到长的那一栏，整层高度不跟着蹿", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await 登录(page);
  // 从账号菜单开：浮层（直接敲 /settings 是整页）
  await expect(async () => {
    if (!(await page.getByRole("menuitem").filter({ hasText: "设置" }).isVisible())) await page.getByRole("button", { name: /账号菜单/ }).click();
    await expect(page.getByRole("menuitem").filter({ hasText: "设置" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("menuitem").filter({ hasText: "设置" }).click({ position: { x: 120, y: 12 } });
  const 层 = page.locator(".setm-box");
  await expect(层).toBeVisible();
  await page.waitForTimeout(400);
  const 高们: number[] = [];
  const 页签 = 层.getByRole("tab");
  for (let i = 0; i < Math.min(await 页签.count(), 5); i++) {
    await 页签.nth(i).click();
    await page.waitForTimeout(150);
    高们.push(Math.round((await 层.boundingBox())!.height));
  }
  expect(new Set(高们).size, `各栏的浮层高度：${高们.join(", ")}`).toBe(1);
});

test.describe("窗口最窄、面板开着", () => {
  test.beforeAll(async ({ browser }) => 装个假模型(browser));
  test.afterAll(async ({ browser }) => 拆掉假模型(browser));

  /* J-200 后半：1024 宽、右边面板开着时正文只剩四百来宽，页头名字被右边四颗按钮挤到 3px，「钱同学」一字一行 */
  test("J-200：1024 宽打开面板看记录页，页头名字一行摆下（至少留几个字宽），不竖排", async ({ page }) => {
    const p = 连库();
    const 我 = await p.user.findFirstOrThrow({ where: { email: 账号.用户名 } });
    const c = await p.customer.create({ data: { name: "钱同学", phone: "13900005252", salesOwnerId: 我.id } });
    try {
      await page.setViewportSize({ width: 1024, height: 768 });
      await 登录(page);
      await page.goto(`/customers/${c.id}`);
      const 开键 = page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /打开 AI 面板/ });
      if (await 开键.isVisible()) await 开键.click();
      await expect(page.locator("aside.dock")).toBeVisible();
      const 名 = page.locator(".rec-head-name").first();
      await expect(名).toContainText("钱同学");
      const 量 = await 名.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const 块 = el.closest(".rec-head-id")!.getBoundingClientRect();
        const 行高 = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.4;
        return { 高: r.height, 行高, 块宽: 块.width, 字号: parseFloat(getComputedStyle(el).fontSize), 截了: el.scrollWidth > el.clientWidth + 1 };
      });
      expect(量.高, `名字高 ${量.高}，一行 ${量.行高}`).toBeLessThan(量.行高 * 1.6);
      expect(量.截了, "三个字的名字被省略了").toBe(false);
      // 名字那一块至少留几个字宽（原来 min-width: 0，被右边按钮挤到 3px）
      expect(量.块宽, `名字那块只剩 ${量.块宽} 宽`).toBeGreaterThanOrEqual(量.字号 * 3);
    } finally {
      await p.customer.delete({ where: { id: c.id } });
      await p.$disconnect();
    }
  });
});
