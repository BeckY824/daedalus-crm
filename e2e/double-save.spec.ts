/**
 * 记录页上四个弹框连点保存只建一条（2026-10-04 J-107）。
 *
 * fc06ead、5dae73e 给添加联系人 / 新建待办 / 制定计划 / 记录跟进加了「保存中」防连点，
 * 但只有新建客户那一个有用例（ui-walkthrough::连点两次保存不会建出两条）。一回归就是网慢时
 * 建出两条跟进，连带的待办、计划也各两份——照那条的写法，四个弹框各双击一次保存，数库里多了几条。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库, 清空业务数据 } from "./mock-data";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };

async function 登录(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("用户名").fill(账号.用户名);
  await page.getByPlaceholder("登录密码").fill(账号.密码);
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await page.waitForURL(/\/dashboard/);
}

test.describe.configure({ mode: "serial", timeout: 90_000 });

let 客户id = "";

test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  const 张三 = await p.user.findFirstOrThrow({ where: { email: 账号.用户名 } });
  客户id = (await p.customer.create({ data: { name: "连点测试", phone: "13855550001", salesOwnerId: 张三.id } })).id;
  await p.$disconnect();
});

test.afterAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await p.$disconnect();
});

/** 双击保存，等框关掉、手上的请求都回来，再多等一会儿：第二下要是漏过去了，它的那条也该落库了 */
async function 连点保存(page: Page, 框: ReturnType<Page["getByRole"]>, 钮: RegExp) {
  await 框.getByRole("button", { name: 钮 }).click({ clickCount: 2, delay: 0 }).catch(() => {});
  await expect(框).toBeHidden();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);
}

/**
 * 点开弹框。dev server 下页面刚出来时可能还没水合完，第一下点了没反应——没开就再点，别把它当成用例失败
 */
async function 打开(page: Page, 按钮: string, 框名: string) {
  const 框 = page.getByRole("dialog", { name: 框名 });
  await expect(async () => {
    if (!(await 框.isVisible())) await page.getByRole("button", { name: 按钮 }).click();
    await expect(框).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  return 框;
}

async function 数(查: (p: ReturnType<typeof 连库>) => Promise<number>) {
  const p = 连库();
  try {
    return await 查(p);
  } finally {
    await p.$disconnect();
  }
}

test("添加联系人：连点两次保存 → 只多一位联系人", async ({ page }) => {
  await 登录(page);
  await page.goto(`/customers/${客户id}`);
  const 框 = await 打开(page, "添加联系人", "添加联系人");
  await 框.getByPlaceholder("张经理").fill("连点联系人");
  await 连点保存(page, 框, /保\s*存/);
  expect(await 数((p) => p.contact.count({ where: { customerId: 客户id, name: "连点联系人" } })), "连点两次建出了两位联系人").toBe(1);
});

test("新建待办：连点两次创建 → 只多一条待办", async ({ page }) => {
  await 登录(page);
  await page.goto(`/customers/${客户id}`);
  const 框 = await 打开(page, "新建任务", "新建待办任务");
  await 框.getByLabel("任务内容").fill("连点待办");
  await 连点保存(page, 框, /创\s*建/);
  expect(await 数((p) => p.task.count({ where: { customerId: 客户id, title: "连点待办" } })), "连点两次建出了两条待办").toBe(1);
});

test("制定跟进计划：连点两次保存 → 只多一条计划", async ({ page }) => {
  await 登录(page);
  await page.goto(`/customers/${客户id}`);
  const 框 = await 打开(page, "制定跟进计划", "制定跟进计划");
  await 框.getByLabel("跟进主题").fill("连点计划");
  await 连点保存(page, 框, /保\s*存/);
  expect(await 数((p) => p.followPlan.count({ where: { customerId: 客户id, subject: "连点计划" } })), "连点两次建出了两条计划").toBe(1);
});

test("记录跟进（带截止时间、连带建待办）：连点两次保存 → 跟进和连带的待办都只一份", async ({ page }) => {
  await 登录(page);
  await page.goto(`/customers/${客户id}`);
  const 框 = await 打开(page, "记录跟进", "新建跟进");
  // 换成「跟进任务」才有截止时间；填了截止时间、状态没做完，保存时顺带建一条待办
  await 框.getByLabel("跟进类型").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content", { hasText: "跟进任务" }).click();
  // 还没做完（待处理）的才连带建待办，见 saveFollowUp
  await 框.getByLabel("状态").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content", { hasText: "待处理" }).click();
  await 框.getByLabel("沟通内容").fill("连点跟进");
  const 截止 = 框.getByLabel("截止时间");
  await 截止.click();
  await 截止.pressSequentially("2030-01-15 09:00");
  // 带时间的选择器要点「确定」才算数（光回车有时不认）
  await page.locator(".ant-picker-dropdown:not(.ant-picker-dropdown-hidden) .ant-picker-ok button").click();
  await expect(截止).toHaveValue("2030-01-15 09:00");
  await 连点保存(page, 框, /保\s*存/);
  expect(await 数((p) => p.followUp.count({ where: { customerId: 客户id, content: "连点跟进" } })), "连点两次建出了两条跟进").toBe(1);
  expect(await 数((p) => p.task.count({ where: { customerId: 客户id, title: "连点跟进" } })), "连带的待办建了两份").toBe(1);
});
