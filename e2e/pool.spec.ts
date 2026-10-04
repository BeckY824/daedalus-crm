/**
 * 公海轻量（2026-10-03，0.46.15 第 6 块）：张三把自己的客户放进公海 → 李四在「公海」里看到「公海（原 张三）」→
 * 领取，负责人变成李四 → 撤销，又回到公海 → 记录页上也有那枚标签和「领取」。
 * 种子库本来就有三个人（多人），公海的入口才出现。造的客户结束时删掉。
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";

const 张三 = { 用户名: "zhangsan", 密码: "admin123" };
const 李四 = { 用户名: "lisi", 密码: "admin123" };
const 客户名 = "公海测试客户";
/** multiuser 的 E 组会停用李四且不恢复（duplicate.spec 里也记着）：这里先启用，结束时还原成原样，不改别人的前提 */
let 原在职: { email: string; active: boolean }[] = [];

async function 登录(page: Page, who: { 用户名: string; 密码: string }) {
  for (let i = 0; i < 3; i++) {
    await page.goto("/login");
    await page.getByPlaceholder("用户名").fill(who.用户名);
    await page.getByPlaceholder("登录密码").fill(who.密码);
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

async function 一个人(browser: Browser, who: { 用户名: string; 密码: string }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await 登录(page, who);
  return { ctx, page };
}

test.beforeAll(async () => {
  const db = 连库();
  try {
    await db.customer.deleteMany({ where: { name: 客户名 } });
    原在职 = await db.user.findMany({ where: { email: { in: ["zhangsan", "lisi"] } }, select: { email: true, active: true } });
    await db.user.updateMany({ where: { email: { in: ["zhangsan", "lisi"] } }, data: { active: true } });
    const 张 = await db.user.findUniqueOrThrow({ where: { email: "zhangsan" } });
    await db.customer.create({ data: { name: 客户名, phone: "13755550061", salesOwnerId: 张.id } });
  } finally {
    await db.$disconnect();
  }
});

test.afterAll(async () => {
  const db = 连库();
  await db.customer.deleteMany({ where: { name: 客户名 } });
  for (const u of 原在职) await db.user.update({ where: { email: u.email }, data: { active: u.active } });
  await db.$disconnect();
});

test("放进公海 → 别人在公海里领走 → 撤销回到公海；记录页有标签和领取", async ({ browser }) => {
  const 张 = await 一个人(browser, 张三);
  // 张三：搜到这一位，勾上，批量「放进公海」
  await 张.page.goto(`/customers?keyword=${encodeURIComponent(客户名)}`);
  const 行 = 张.page.getByRole("row", { name: new RegExp(客户名) });
  await expect(行).toBeVisible();
  await 行.getByRole("checkbox").check();
  await 张.page.getByRole("button", { name: "放进公海" }).click();
  await expect(张.page.getByText("已放进公海 1 位")).toBeVisible();
  await expect(行.getByText("公海（原 张三）")).toBeVisible();
  await 张.ctx.close();

  const 李 = await 一个人(browser, 李四);
  const page = 李.page;
  // 李四：负责人下拉里选「公海」，这一位在里面
  await page.goto("/customers");
  await page.locator(".list-bar .ant-select").filter({ hasText: "全部负责人" }).click();
  const 下拉 = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
  await 下拉.waitFor({ state: "visible" });
  await 下拉.getByTitle("公海", { exact: true }).click();
  await expect(page).toHaveURL(/pool=1/);
  const 公海行 = page.getByRole("row", { name: new RegExp(客户名) });
  await expect(公海行.getByText("公海（原 张三）")).toBeVisible();

  // 行上「领取」
  await 公海行.getByRole("button", { name: `领取 ${客户名}` }).click();
  const 提示 = page.locator(".ant-message").filter({ hasText: "已领取 1 位" });
  await expect(提示).toBeVisible();
  // 领走了：公海里没有它了
  await expect(page.getByRole("row", { name: new RegExp(客户名) })).toHaveCount(0);
  const db = 连库();
  try {
    const c = await db.customer.findFirstOrThrow({ where: { name: 客户名 }, include: { salesOwner: true, pool: true } });
    expect(c.salesOwner.name).toBe("李四");
    expect(c.pool).toBeNull();

    // 撤销：还给张三、放回公海
    await 提示.getByRole("button", { name: "撤销" }).click();
    await expect(page.getByText(/已撤销，1 位改回原样/)).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(客户名) }).getByText("公海（原 张三）")).toBeVisible();
    const d = await db.customer.findFirstOrThrow({ where: { name: 客户名 }, include: { salesOwner: true, pool: true } });
    expect(d.salesOwner.name).toBe("张三");
    expect(d.pool).not.toBeNull();

    // 记录页：标签 + 领取
    await page.goto(`/customers/${d.id}`);
    await expect(page.locator(".rec-pool:visible").getByText("公海（原 张三）")).toBeVisible();
    await page.locator(".rec-pool:visible").getByRole("button", { name: /领取/ }).click();
    await expect(page.getByText("已领取，负责人改成你")).toBeVisible();
    await expect(page.locator(".rec-pool:visible")).toHaveCount(0);
  } finally {
    await db.$disconnect();
    await 李.ctx.close();
  }
});

/*
  T-046：负责人格写「公海（原 X）」，同事名字很长时整枚标签压到右边「最近跟进」那一列上。
  修法是表格里的标签不超出格子（max-width: 100% + 省略号，title 里留全名）
*/
test("同事名字很长：「公海（原 …）」标签不超出负责人那一格，压不到「最近跟进」上", async ({ browser }) => {
  const db = 连库();
  const 长名 = "欧阳长长长长长长长长长长名字的同事";
  const 名 = "公海长名客户";
  await db.customer.deleteMany({ where: { name: 名 } });
  await db.user.deleteMany({ where: { email: "pool-long-name" } });
  const 同事 = await db.user.create({ data: { email: "pool-long-name", name: 长名, password: "x", role: "SALES", title: "销售", active: false } });
  const c = await db.customer.create({ data: { name: 名, phone: "13755550062", salesOwnerId: 同事.id } });
  await db.customerPool.create({ data: { customerId: c.id, reason: "手动" } });
  const 张 = await 一个人(browser, 张三);
  try {
    await 张.page.setViewportSize({ width: 1280, height: 800 });
    await 张.page.goto(`/customers?pool=1&keyword=${encodeURIComponent(名)}`);
    const 行 = 张.page.getByRole("row", { name: new RegExp(名) });
    const 标签 = 行.locator(".pool-tag");
    await expect(标签).toBeVisible();
    // 全名留在 title 里，悬停看得到
    await expect(标签).toHaveAttribute("title", new RegExp(长名));
    const 格 = 标签.locator("xpath=ancestor::td[1]");
    const 下一格 = 格.locator("xpath=following-sibling::td[1]");
    const [t, g, n] = await Promise.all([标签.boundingBox(), 格.boundingBox(), 下一格.boundingBox()]);
    expect(t && g && n, "拿不到位置").toBeTruthy();
    expect(t!.x + t!.width, `标签右边 ${t!.x + t!.width} 超出了负责人那一格（右边 ${g!.x + g!.width}）`).toBeLessThanOrEqual(g!.x + g!.width + 0.5);
    expect(t!.x + t!.width, "标签压到了下一列").toBeLessThanOrEqual(n!.x + 0.5);
  } finally {
    await 张.ctx.close();
    await db.customer.deleteMany({ where: { name: 名 } });
    await db.user.deleteMany({ where: { email: "pool-long-name" } });
    await db.$disconnect();
  }
});
