/**
 * 批 2「三张母版」和批 3「列表扩展」的验收。
 *
 * 首页只有配了 AI 才是对话面（没配就直接是数据看板），而默认 e2e 是不配的——
 * 配了每条用例都会真的去打模型，慢、花钱、结果还随模型抖动。
 * 所以这一组自己在「设置 → AI 接入」里填一把假 Key 把对话面打开，跑完删掉。
 * 打开的只是**界面**：真去调用会连不上那个假地址，而这组一次模型都不调。
 *
 * 为什么要走界面而不是直接往库里写一行：设置读取有进程内缓存，只有走
 * `setSetting` 的那条路才会让它失效（见 lib/settings.ts 的注释）。
 * 绕过去写进去的那一行，长期跑着的 dev server 根本读不到——
 * 这条用例第一次写完单独跑是绿的、进了整套就挂，就是这么回事。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库, 清空业务数据, 造模拟数据 } from "./mock-data";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };
/** 只有管理员能改 AI 接入 */
const 管理员 = { 用户名: "admin", 密码: "admin123" };

async function 登录(page: Page, who = 账号) {
  await page.goto("/login");
  const 提示 = page.locator(".ant-alert");
  for (let i = 0; i < 3; i++) {
    await page.getByPlaceholder("用户名").fill(who.用户名);
    await page.getByPlaceholder("登录密码").fill(who.密码);
    await page.getByRole("button", { name: /登\s*录/ }).click();
    for (let t = 0; t < 40; t++) {
      if (/\/dashboard/.test(page.url())) return;
      if (await 提示.isVisible().catch(() => false)) throw new Error("登录失败");
      await page.waitForTimeout(200);
    }
  }
  throw new Error("登录没反应");
}

test.describe.configure({ mode: "serial", timeout: 90_000 });

test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await p.$disconnect();
});

test("先把 AI 接入填上——首页是对话面还是数据看板，就看这一项", async ({ page }) => {
  await 登录(page, 管理员);
  await page.goto("/settings?tab=ai");
  await page.getByLabel("接口地址").fill("http://127.0.0.1:9/v1");
  await page.getByLabel("API Key").fill("e2e-不会真的用它");
  await page.getByLabel("模型名").fill("e2e-model");
  await page.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.locator(".ant-message")).toContainText("已保存");
});

test.afterAll(async () => {
  // 库里收拾干净就行。dev server 那边的设置缓存不用管：每轮 e2e 都是新库新进程
  const p = 连库();
  await p.setting.deleteMany({ where: { key: "llm" } });
  await 清空业务数据(p);
  await p.$disconnect();
});

test("空库首页：一张「开始」卡，整页只有一个主按钮，没有指标卡", async ({ page }) => {
  await 登录(page);
  await page.goto("/dashboard");
  await page.waitForSelector(".start");

  // 三步说清它替你做什么
  await expect(page.locator(".start-steps li")).toHaveCount(3);
  // 「每页一个主动作」：空库时整个正文里只能有一个主按钮
  await expect(page.locator("main .ant-btn-primary")).toHaveCount(1);
  // 空库不画任何指标：四个 0 比没有更糟
  await expect(page.locator("main .stat-card")).toHaveCount(0);
  await expect(page.locator("main .signals")).toHaveCount(0);
});

test("有数据的首页：一行三个信号，不是三张卡", async ({ page }) => {
  const p = 连库();
  await 造模拟数据(p);
  await p.$disconnect();

  await 登录(page);
  await page.goto("/dashboard");
  await page.waitForSelector(".signals");

  await expect(page.locator(".signals .signal")).toHaveCount(3);
  // 指标卡一张都不能有——原来的方案是三张 KPI 卡叠三张「可以直接开始」卡
  await expect(page.locator("main .stat-card")).toHaveCount(0);
  // 每个信号都要能点进一个能把这个数重新数一遍的页面，且都带口径
  for (const 信号 of await page.locator(".signals .signal").all()) {
    expect(await 信号.getAttribute("href")).toBeTruthy();
    expect((await 信号.getAttribute("title")) ?? "").not.toBe("");
  }
});

test("首页：⌘K 把光标放回输入框", async ({ page }) => {
  await 登录(page);
  await page.goto("/dashboard");
  await page.waitForSelector(".cli-input textarea");
  await page.locator("body").click();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".cli-input textarea")).toBeFocused();
});

test("学员列表：空库时不摆筛选栏，主动作还在原位", async ({ page }) => {
  const p = 连库();
  await 清空业务数据(p);
  await p.$disconnect();

  await 登录(page);
  await page.goto("/customers");
  await page.waitForSelector(".list");
  await expect(page.getByPlaceholder("姓名 / 电话 / 院校 / 专业")).toHaveCount(0);
  // 「新建」任何时候都在：空状态里那个是引导，不是它的替代品
  await expect(page.getByRole("button", { name: /新建学员/ })).toBeVisible();
});

test("学员列表：默认只摆六列，其余在「列」里", async ({ page }) => {
  const p = 连库();
  await 造模拟数据(p);
  await p.$disconnect();

  await 登录(page);
  await page.goto("/customers");
  await page.waitForSelector(".ant-table-row");

  // 六列 + 勾选框 + 操作列
  const 表头 = await page.locator(".ant-table-thead th").allInnerTexts();
  expect(表头.filter((t) => t.trim()).length).toBe(6);

  // 收起来的列要能勾出来
  await page.getByRole("button", { name: "列" }).click();
  const 菜单 = page.locator(".ant-dropdown:not(.ant-dropdown-hidden)");
  await 菜单.waitFor({ state: "visible" });
  await 菜单.getByText("联系电话").click();
  await expect(page.locator(".ant-table-thead th", { hasText: "联系电话" })).toBeVisible();
});

test("学员记录：左边有窄名单，切人不回列表", async ({ page }) => {
  await page.setViewportSize({ width: 1560, height: 900 });
  await 登录(page);
  await page.goto("/customers");
  await page.waitForSelector(".ant-table-row");
  await page.locator(".ant-table-row .link-strong").first().click();
  await expect(page).toHaveURL(/\/customers\/[^/]+$/);

  const 名单 = page.locator("aside.pane-roster");
  await expect(名单).toBeVisible();
  const 第一位 = page.url();

  // 点名单里的另一位：URL 换人，名单还在——不用退回列表再进去
  await 名单.locator(".roster-row").nth(1).click();
  await expect(page).not.toHaveURL(第一位);
  await expect(page).toHaveURL(/\/customers\/[^/]+$/);
  await expect(名单).toBeVisible();
});

test("学员记录：窄屏下名单收成抽屉，但「换一位」这条路还在", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await 登录(page);
  await page.goto("/customers");
  await page.waitForSelector(".ant-table-row");
  await page.locator(".ant-table-row .link-strong").first().click();
  await expect(page).toHaveURL(/\/customers\/[^/]+$/);

  await expect(page.locator("aside.pane-roster")).toHaveCount(0);
  const 按钮 = page.getByRole("button", { name: /换一位/ });
  await expect(按钮).toBeVisible();
  await 按钮.click();
  await expect(page.locator(".ant-drawer .roster-row").first()).toBeVisible();
});

/* ---------- 批 3 ---------- */

test("跟进计划：按逾期 / 今天 / 本周分三组，逾期那组是红的", async ({ page }) => {
  // 先清再造：前面几条已经造过一套，直接再造一次会撞渠道名的唯一约束
  const p = 连库();
  await 清空业务数据(p);
  await 造模拟数据(p);
  await p.$disconnect();

  await 登录(page);
  await page.goto("/follow-ups/plans");
  await page.waitForSelector(".plan-g");

  const 组名 = await page.locator(".plan-g-h b").allInnerTexts();
  expect(组名.slice(0, 3)).toEqual(["逾期", "今天", "本周"]);

  // 逾期不能只靠排在最前面：颜色得跟上，扫过去才看得见
  const 红 = await page.locator(".plan-g-warn .plan-g-h b").evaluate((el) => getComputedStyle(el).color);
  expect(红, "逾期那一组的标题没有标红").not.toBe("rgb(17, 24, 39)");

  // 每一组都要说清自己是什么，空的那组也要
  for (const 说明 of await page.locator(".plan-g-s").allInnerTexts()) {
    expect(说明.trim().length).toBeGreaterThan(3);
  }
});

test("商机管道：列头写着这一阶段压着多少钱", async ({ page }) => {
  await 登录(page);
  await page.goto("/opportunities/pipeline");
  await page.waitForSelector(".pipe-col");
  const 合计 = await page.locator(".pipe-sum").allInnerTexts();
  expect(合计.length).toBeGreaterThan(0);
  for (const x of 合计) expect(x).toMatch(/¥|￥|\d/);
});

test("1024 下管道自己横滚，页面不跟着被撑开", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await 登录(page);
  await page.goto("/opportunities/pipeline");
  await page.waitForSelector(".pipe-col");

  const r = await page.evaluate(() => {
    const d = document.documentElement;
    const pipe = document.querySelector(".pipe")!;
    return {
      页面溢出: d.scrollWidth > d.clientWidth + 1,
      管道能横滚: pipe.scrollWidth > pipe.clientWidth,
    };
  });
  expect(r.页面溢出, "整页被管道撑出了横向滚动条").toBe(false);
  expect(r.管道能横滚, "管道那一块自己得能横滚，否则右边几列就看不到了").toBe(true);
});
