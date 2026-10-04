/**
 * 回归总表「L-联动」里服务端钉着、界面那一半没钉的几条（2026-10-04 上线前第 2 期补测）：
 *   L-025 编辑框只换推荐渠道：渠道负责人跟着变成新渠道的人（表单只在动过那一格才回传渠道负责人）
 *   L-046 记录页头「已签约」后面写的是签约日，不是预计签约日
 *   L-013 清除演示数据的确认框用这个工作区的叫法、列全、不露 Markdown 星号
 * 每条自己造数据；改了叫法的那条在 finally 里改回「客户」，afterAll 再删一次兜底。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库, 清空业务数据 } from "./mock-data";

const 管理员 = { 用户名: "admin", 密码: "admin123" };
const 戳 = String(Date.now()).slice(-5);

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
      /* 没水合时第一下会落空，再试 */
    }
  }
  throw new Error("登录失败");
}

async function 改客户名词(page: Page, 名词: string) {
  await page.goto("/settings");
  await page.getByRole("tab", { name: "业务配置" }).click();
  const 面板 = page.getByRole("tabpanel", { name: "业务配置" });
  await 面板.getByLabel("客户叫什么").fill(名词);
  await 面板.getByRole("button", { name: /^保\s*存$/ }).click();
  await expect(page.getByText("已保存，全站措辞已更新")).toBeVisible({ timeout: 15_000 });
}

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await p.$disconnect();
});
test.afterAll(async () => {
  const p = 连库();
  await p.setting.deleteMany({ where: { key: { in: ["business", "demoDataSeededAt"] } } });
  await 清空业务数据(p);
  await p.$disconnect();
});

test("L-025 编辑框只换推荐渠道：保存后渠道负责人是新渠道的人，不钉在旧人", async ({ page }) => {
  const p = 连库();
  const 张三 = await p.user.findFirstOrThrow({ where: { email: "zhangsan" } });
  const 李四 = await p.user.findFirstOrThrow({ where: { email: "lisi" } });
  const 旧渠道 = await p.channel.create({ data: { name: `旧渠道${戳}`, channelOwnerId: 张三.id } });
  await p.channel.create({ data: { name: `新渠道${戳}`, channelOwnerId: 李四.id } });
  const c = await p.customer.create({
    data: { name: `换渠道${戳}`, phone: `1389${戳}01`.slice(0, 11), salesOwnerId: 张三.id, channelId: 旧渠道.id, attributionChannelId: 旧渠道.id, channelOwnerId: 张三.id },
  });
  await p.$disconnect();

  await 登录(page);
  await page.goto("/customers");
  await page.getByRole("button", { name: `编辑 换渠道${戳}` }).click();
  const 框 = page.getByRole("dialog");
  await 框.locator(".ant-select", { hasText: `旧渠道${戳}` }).click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").getByText(`新渠道${戳}`, { exact: true }).click();
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.locator(".ant-message")).toContainText("已保存");

  const q = 连库();
  expect(await q.customer.findUniqueOrThrow({ where: { id: c.id }, select: { channelOwnerId: true } })).toEqual({ channelOwnerId: 李四.id });
  await q.$disconnect();
  await page.goto(`/customers/${c.id}`);
  await expect(page.locator(".rec-field", { hasText: "渠道负责人" })).toContainText("李四");
});

test("L-046 记录页头「已签约」后面是签约日（回填的上个月那天），不是预计签约日", async ({ page }) => {
  const p = 连库();
  const 我 = await p.user.findFirstOrThrow({ where: { email: 管理员.用户名 } });
  const c = await p.customer.create({
    data: { name: `签约日${戳}`, phone: `1389${戳}02`.slice(0, 11), salesOwnerId: 我.id, followStatus: "已签约", expectedSignAt: new Date(2026, 10, 20) },
  });
  await p.contract.create({ data: { customerId: c.id, amount: 6600, signedAt: new Date(2026, 8, 15, 10) } });
  await p.$disconnect();

  await 登录(page);
  await page.goto(`/customers/${c.id}`);
  const 头 = page.locator(".rec-tags-n", { hasText: "已签约" });
  await expect(头).toContainText("2026-09-15");
  await expect(头).not.toContainText("2026-11-20");
});

test("L-013 清除演示数据的确认框：叫「学员」时写学员、列全会删什么、不露 ** 星号", async ({ page }) => {
  const p = 连库();
  await p.setting.upsert({ where: { key: "demoDataSeededAt" }, create: { key: "demoDataSeededAt", value: new Date().toISOString() }, update: {} });
  await p.$disconnect();

  await 登录(page);
  await 改客户名词(page, "学员");
  try {
    const 面板 = page.getByRole("tabpanel", { name: "业务配置" });
    const 区 = 面板.locator(".biz-demo");
    await expect(区).toContainText("一套虚构的学员");
    await expect(区).not.toContainText("**");
    await 区.getByRole("button", { name: /清除演示数据/ }).click();
    const 框 = page.getByRole("dialog", { name: "清除演示数据？" });
    await expect(框).toContainText("学员和他们的联系人、线索、渠道、商机、签约、跟进记录、计划和待办、导入记录、操作日志");
    await expect(框).not.toContainText("**");
    await expect(框).not.toContainText("客户");
    // 只看框，不滑：这条不真清库
    await page.keyboard.press("Escape");
    await expect(框).toBeHidden();
  } finally {
    await 改客户名词(page, "客户");
  }
});
