/**
 * 记录页上的计划与待办（回归核对 D-044 / D-045）。
 *
 *   D-044 到点提醒点进来带 ?focus=plan:<id>。记录页只摆一条计划（最早那条没做完的），
 *         叫你的那条若不是最早的，原来点进来找不到它、也闪不了（5dae73e 修）
 *   D-045 计划 / 待办在记录页上能改能删，刷新以后还是改过、删过的样子（单测只钉了服务端那一层）
 *
 * 数据自己造、自己收：只建一位客户，收尾删掉它（连带的计划、待办一起删），不清别人的数据。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };
const 客户名 = "计划待办测试位";

async function 登录(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("用户名").fill(账号.用户名);
  await page.getByPlaceholder("登录密码").fill(账号.密码);
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await page.waitForURL(/\/dashboard/);
}

test.describe.configure({ mode: "serial", timeout: 90_000 });

let 客户id = "";
const 计划 = { 早: "", 晚: "" };
let 待办id = "";

async function 收拾() {
  const p = 连库();
  const 旧 = await p.customer.findMany({ where: { name: 客户名 }, select: { id: true } });
  const ids = 旧.map((c) => c.id);
  await p.followPlan.deleteMany({ where: { customerId: { in: ids } } });
  await p.task.deleteMany({ where: { customerId: { in: ids } } });
  await p.customer.deleteMany({ where: { id: { in: ids } } });
  await p.$disconnect();
}

test.beforeAll(async () => {
  await 收拾();
  const p = 连库();
  const 我 = await p.user.findFirstOrThrow({ where: { email: 账号.用户名 } });
  客户id = (await p.customer.create({ data: { name: 客户名, phone: "13855550077", salesOwnerId: 我.id } })).id;
  const 天 = 86400_000;
  计划.早 = (await p.followPlan.create({ data: { customerId: 客户id, ownerId: 我.id, subject: "早的那条计划", method: "电话", plannedAt: new Date(Date.now() + 1 * 天) } })).id;
  计划.晚 = (await p.followPlan.create({ data: { customerId: 客户id, ownerId: 我.id, subject: "叫我的那条计划", method: "微信", plannedAt: new Date(Date.now() + 3 * 天) } })).id;
  待办id = (await p.task.create({ data: { customerId: 客户id, ownerId: 我.id, title: "要删掉的待办", dueAt: new Date(Date.now() + 2 * 天) } })).id;
  await p.$disconnect();
});

test.afterAll(收拾);

test.beforeEach(async ({ page }) => {
  await 登录(page);
});

test("D-044 到点提醒点进来（?focus=plan:第二条）：记录页摆的是叫你的那条、闪一下，地址上的 focus 随即抹掉", async ({ page }) => {
  await page.goto(`/customers/${客户id}?focus=plan:${计划.晚}`);
  // 只认 main 里那份：整页加载时 React 流式渲染会先把内容放在 <div hidden id="S:1"> 里、随后才换进来，那一瞬页面上有两份（看不见的那份不算）
  const 那条 = page.locator(`main .rec-plan[data-focus="plan:${计划.晚}"]`);
  await expect(那条).toBeVisible();
  await expect(那条).toContainText("叫我的那条计划");
  await expect(那条).toHaveClass(/rec-tl-item-flash/);
  await expect(page).toHaveURL(new RegExp(`/customers/${客户id}$`));
  // 抹掉 focus 之后不能被重画成最早那条（原来 router.replace 会让服务端按没有 focus 再画一遍，叫你的那条一闪就没了）
  await page.waitForTimeout(2000);
  await expect(page.locator("main .rec-plan")).toHaveCount(1);
  await expect(page.locator("main .rec-plan")).toContainText("叫我的那条计划");
  // 对照：不带 focus 进来，摆的是最早那条
  await page.goto(`/customers/${客户id}`);
  await expect(page.locator(".rec-plan")).toContainText("早的那条计划");
});

test("D-044 叫你的那条已经做完了：照旧摆最早那条没做完的，不是空着", async ({ page }) => {
  const p = 连库();
  await p.followPlan.update({ where: { id: 计划.晚 }, data: { done: true } });
  await p.$disconnect();
  try {
    await page.goto(`/customers/${客户id}?focus=plan:${计划.晚}`);
    await expect(page.locator(".rec-plan")).toContainText("早的那条计划");
  } finally {
    const q = 连库();
    await q.followPlan.update({ where: { id: 计划.晚 }, data: { done: false } });
    await q.$disconnect();
  }
});

test("D-045 记录页上改计划的时间：保存后刷新，库里和页面上都是新时间", async ({ page }) => {
  await page.goto(`/customers/${客户id}`);
  const 计划条 = page.locator(".rec-plan");
  await expect(计划条).toContainText("早的那条计划");
  const 框 = page.getByRole("dialog", { name: "编辑跟进计划" });
  await expect(async () => {
    if (!(await 框.isVisible())) await 计划条.getByRole("button", { name: "改" }).click();
    await expect(框).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  const 新时间 = "2031-05-06 09:30";
  const 时间框 = 框.getByLabel("计划时间");
  await 时间框.click();
  await 时间框.press("ControlOrMeta+a");
  await 时间框.fill(新时间);
  await 时间框.press("Enter");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框).toBeHidden();

  const p = 连库();
  const 存的 = await p.followPlan.findUniqueOrThrow({ where: { id: 计划.早 } });
  await p.$disconnect();
  // e2e 跑在 Asia/Shanghai（playwright.config.ts 的 timezoneId）
  expect(存的.plannedAt.toISOString()).toBe(new Date("2031-05-06T09:30:00+08:00").toISOString());

  await page.reload();
  // 改晚了以后最早那条换成了「叫我的那条」；悬停说的是具体几点
  await expect(page.locator(".rec-plan")).toContainText("叫我的那条计划");
});

test("D-045 记录页上删一条待办：就地确认后消失，刷新也不回来，库里没了", async ({ page }) => {
  await page.goto(`/customers/${客户id}`);
  const 行 = page.locator(`[data-focus="task:${待办id}"]`);
  await expect(行).toContainText("要删掉的待办");
  await 行.getByRole("button", { name: "删除待办" }).click();
  await 行.getByRole("button", { name: /^删\s*除$/ }).click();
  await expect(行).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("要删掉的待办")).toHaveCount(0);
  const p = 连库();
  expect(await p.task.count({ where: { id: 待办id } })).toBe(0);
  await p.$disconnect();
});
