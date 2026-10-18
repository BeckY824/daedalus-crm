/**
 * AI 联网背调，首页从头到尾（2026-10-16）。
 *
 * 和别的 AI 用例不一样：这里**真走服务端**——本机服务的 6 步编排、事件流、卡片、存进客户都是真的，
 * 只有两头换成假的：模型是 scripts/research-fake-llm.ts（按步骤回固定答案），搜索走模拟通道（CRM_RESEARCH_CHANNEL=mock，
 * playwright.config.ts 里钉着）。所以这一组钉的是「整条链接得上」，不是模型答得好不好。
 */
import { test, expect, type Page } from "@playwright/test";
import { 配好AI, 拆掉假模型 } from "./fake-llm";
import { 连库 } from "./mock-data";
import { 起假模型 } from "../scripts/research-fake-llm";

const 账号 = { 用户名: "admin", 密码: "admin123" };
let 假模型: { url: string; close: () => Promise<void> };

async function 登录(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("用户名").fill(账号.用户名);
  await page.getByPlaceholder("登录密码").fill(账号.密码);
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await page.waitForURL(/\/dashboard/);
}

test.beforeAll(async ({ browser }) => {
  假模型 = await 起假模型(0);
  const page = await browser.newPage();
  try {
    await 登录(page);
    await 配好AI(page, 假模型.url);
  } finally {
    await page.close();
  }
});
test.afterAll(async ({ browser }) => {
  await 拆掉假模型(browser);
  await 假模型?.close();
  const db = 连库();
  await db.customer.deleteMany({ where: { name: "Lumora Trading GmbH" } });
  await db.$disconnect();
});

test("首页说「帮我背调 XX」：先出确认卡，开始后 6 步展开，存进客户后档案里有报告和来源链接", async ({ page }) => {
  test.setTimeout(120_000);
  await 登录(page);
  const 框 = page.getByRole("textbox").filter({ hasNot: page.locator("[type=search]") }).last();
  await 框.fill("帮我背调 Lumora Trading GmbH");
  await 框.press("Enter");

  // 1. 不自己跑：先问
  const 确认 = page.getByRole("group", { name: "背调确认" });
  await expect(确认).toContainText("Lumora Trading GmbH");
  await expect(确认).toContainText("模拟数据");
  await 确认.getByRole("button", { name: "开始背调" }).click();

  // 2. 跑完：6 步都打勾，公司卡、分数、来源都在
  const 卡 = page.getByRole("region", { name: "背调 Lumora Trading GmbH" });
  await expect(卡.locator(".rs-pill")).toHaveText("已完成", { timeout: 60_000 });
  await expect(卡.locator(".rs-stage-done")).toHaveCount(6);
  await expect(卡).toContainText("lumora-trading.example");
  await expect(卡).toContainText("进口分销商");
  await expect(卡.locator(".rs-score-num")).toHaveText(/^\d+$/);
  await expect(卡.locator(".rs-srcs li").first()).toContainText("Lumora Trading GmbH");
  // 真实性（10-18）：服务器那头的程序直查走模拟（mock.ts 模拟核验），网上足迹从模拟的 LinkedIn / Facebook 搜索结果认
  const 真 = 卡.locator(".rs-trust");
  await expect(真).toContainText("程序直查 · 不经模型");
  await expect(真.locator(".rs-check")).toHaveCount(9);
  await expect(真).toContainText("示例登记库");
  await expect(真).toContainText("Facebook 主页：有");
  await expect(卡.locator(".rs-fit-light")).toContainText("真实性");
  await expect(卡.locator(".rs-fields")).toContainText("进口记录");

  // 3. 存进客户：库里没有像的，新建一位（邮箱已经按查到的填好）
  await 卡.getByRole("button", { name: "存进客户" }).click();
  await expect(卡.getByLabel("邮箱")).toHaveValue("sales@lumora-trading.example");
  await 卡.getByLabel("电话").fill("13800138111");
  await 卡.getByRole("button", { name: "新建客户并存入" }).click();
  await expect(卡.getByRole("button", { name: /已存进「Lumora Trading GmbH」/ })).toBeVisible();

  const db = 连库();
  try {
    const c = await db.customer.findFirst({ where: { name: "Lumora Trading GmbH" }, include: { followUps: true, extra: true } });
    expect(c?.extra?.source).toBe("AI 背调");
    const 报告 = c?.followUps.find((f) => f.title.startsWith("背调｜Lumora Trading GmbH"));
    expect(报告?.type).toBe("OTHER");
    expect(报告?.content).toContain("【来源】");
    expect(报告?.content).toContain("https://lumora-trading.example/about");
    expect(报告?.content).toContain("【真实性】");
  } finally {
    await db.$disconnect();
  }

  // 4. 翻历史：这一轮读回来还是背调卡，不是一段字
  await page.reload();
  await expect(page.getByRole("region", { name: "背调 Lumora Trading GmbH" }).locator(".rs-pill")).toHaveText("已完成");
});

test("问背调本身的问题不当成要背调：照常走问答", async ({ page }) => {
  await 登录(page);
  const 框 = page.getByRole("textbox").filter({ hasNot: page.locator("[type=search]") }).last();
  await 框.fill("背调要多少钱");
  await 框.press("Enter");
  await expect(page.getByRole("group", { name: "背调确认" })).toHaveCount(0);
});

test("背调模式：选中有明显状态，发出去直接开跑；认不准先点选；再点一下回到普通问答", async ({ page }) => {
  test.setTimeout(120_000);
  await 登录(page);
  const 开关 = page.getByRole("button", { name: "背调", exact: true });
  await expect(开关).toHaveAttribute("aria-pressed", "false");
  await 开关.click();
  await expect(开关).toHaveAttribute("aria-pressed", "true");
  const 框 = page.getByPlaceholder("输入公司名、官网或一句需求，比如：帮我查 Rexel 适不适合我们");
  await expect(框).toBeVisible();
  // 扣费说在前面（e2e 走模拟通道：不扣次数）
  await expect(page.getByText("背调 · 开发环境用模拟数据，不扣次数")).toBeVisible();

  // 1. 发出去 = 直接开跑，不出确认卡
  await 框.fill("帮我查 Lumora Trading GmbH 适不适合我们");
  await 框.press("Enter");
  const 卡 = page.getByRole("region", { name: "背调 Lumora Trading GmbH" });
  await expect(卡.locator(".rs-pill")).toHaveText("已完成", { timeout: 60_000 });
  await expect(page.getByRole("group", { name: "背调确认" })).toHaveCount(0);

  // 2. 一句里两家：先点选（不扣次数），点了才跑
  await 框.fill("Nordwerk 和 Polaris Elektro");
  await 框.press("Enter");
  const 选 = page.getByRole("group", { name: "选要背调的公司" });
  await expect(选).toContainText("还没扣次数");
  await 选.getByRole("button", { name: "背调「Polaris Elektro」" }).click();
  await expect(page.getByRole("region", { name: "背调 Polaris Elektro" }).locator(".rs-pill")).toHaveText("已完成", { timeout: 60_000 });

  // 3. 再点一下：回到普通问答
  await 开关.click();
  await expect(开关).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByPlaceholder("输入公司名、官网或一句需求，比如：帮我查 Rexel 适不适合我们")).toHaveCount(0);
});

test("背调模式里粘贴询盘邮件（第二期）：本机认出发件人和 IP，带着它开跑，真实性里「邮件头」一项按 IP 国家定灯", async ({ page }) => {
  test.setTimeout(120_000);
  await 登录(page);
  await page.getByRole("button", { name: "背调", exact: true }).click();
  await page.getByRole("button", { name: "粘贴询盘邮件" }).click();
  const 原文 = [
    "Received: from mail.lumora-trading.example (mail.lumora-trading.example [94.200.1.10]) by mx.ourfactory.cn with ESMTP id 1",
    "Authentication-Results: mx.ourfactory.cn; spf=pass smtp.mailfrom=lumora-trading.example",
    "From: Jonas <jonas@lumora-trading.example>",
    "Subject: Inquiry",
    "",
    "Dear Sir, please quote 500 pcs.",
  ].join("\n");
  await page.getByRole("textbox", { name: "询盘邮件原文" }).fill(原文);
  await page.getByRole("button", { name: "带上这封邮件" }).click();
  await expect(page.getByText("带上询盘邮件：jonas@lumora-trading.example · 发件 IP 94.200.1.10")).toBeVisible();

  const 框 = page.getByPlaceholder("输入公司名、官网或一句需求，比如：帮我查 Rexel 适不适合我们");
  await 框.fill("Lumora Trading GmbH");
  await 框.press("Enter");
  const 卡 = page.getByRole("region", { name: "背调 Lumora Trading GmbH" }).last();
  await expect(卡.locator(".rs-pill")).toHaveText("已完成", { timeout: 60_000 });
  // 发出去就不带了：下一轮要再贴
  await expect(page.getByText(/带上询盘邮件：/)).toHaveCount(0);
  // 模拟查 IP：94.x 当阿联酋；官网认出来是德国 → 对不上，黄
  const 邮件头 = 卡.locator(".rs-check").filter({ hasText: "邮件头" });
  await expect(邮件头).toContainText("发件 IP 94.200.1.10（最早一跳）在阿联酋");
  await expect(邮件头).toContainText("SPF 通过");
});

test("只有人名 + 电话（10-18）：先判号码，找公司出候选，点选接着背调（同一次、不另扣）；号码搜不到出「只有人」简版", async ({ page }) => {
  test.setTimeout(150_000);
  await 登录(page);
  await page.getByRole("button", { name: "背调", exact: true }).click();
  const 框 = page.getByPlaceholder("输入公司名、官网或一句需求，比如：帮我查 Rexel 适不适合我们");

  // 1. 名字 + 号码：模拟搜索里这个号码出现在 Lumora 的名录页上 → 候选 → 点选 → 背调这家
  await 框.fill("Anna Beispiel +49 40 0000 0000");
  await 框.press("Enter");
  const 确认 = page.getByRole("group", { name: "找这个人所在的公司" });
  await expect(确认).toContainText("德国");
  await expect(确认).toContainText("模拟数据");
  await 确认.getByRole("button", { name: "开始找公司" }).click();
  await page.getByRole("button", { name: "背调这家" }).click({ timeout: 60_000 });
  const 卡 = page.getByRole("region", { name: "背调 Lumora Trading GmbH" });
  await expect(卡.locator(".rs-pill")).toHaveText("已完成", { timeout: 60_000 });
  await expect(卡.locator(".rs-from-person")).toBeVisible();
  await expect(卡.locator(".rs-trust")).toContainText("人和号码");
  // 10-18 对比免费产品加的几块，整条链接得上（假模型按步骤回固定答案）
  await expect(卡).toContainText("风险必查");
  await expect(卡).toContainText("在卖的型号");
  await expect(卡).toContainText("HB-150");
  await expect(卡).toContainText("英文开发信");
  await expect(卡.locator(".rs-verdict")).toBeVisible();

  // 2. 只有号码、网上搜不到：「只有人」简版
  await 框.fill("+44 20 7946 0123");
  await 框.press("Enter");
  const 确认2 = page.getByRole("group", { name: "找这个人所在的公司" }).last();
  await 确认2.getByRole("button", { name: "开始找公司" }).click();
  await expect(page.locator(".rs-thin").last()).toContainText("信息少，谨慎", { timeout: 60_000 });
  await expect(page.locator(".rs-card").last()).toContainText("没有登录、没有抓取");
});
