/**
 * 列表里「所属客户」一格两行：上面人名、下面公司（2026-10-19 用户定：不加新列，同一格两行）。
 *
 *   跟进记录：有公司的那位，人名下面一行灰字公司、悬停看全名；没填公司的那位只有一行
 *   搜索框按公司名也搜得到，占位写着能搜公司
 *   商机列表同样摆、同样能按公司搜
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";

const 前缀 = "两行公司测试";
const 公司 = `${前缀}·临沂佳盈国际食品贸易有限公司`;

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

async function 收拾() {
  const db = 连库();
  try {
    await db.customer.deleteMany({ where: { name: { startsWith: 前缀 } } });
  } finally {
    await db.$disconnect();
  }
}

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async () => {
  await 收拾();
  const db = 连库();
  try {
    const 我 = await db.user.findFirstOrThrow({ where: { email: "zhangsan" } });
    for (const [名, 校] of [[`${前缀}·王建国`, 公司], [`${前缀}·李没公司`, null]] as const) {
      const c = await db.customer.create({ data: { name: 名, school: 校, phone: `86138${Math.floor(Math.random() * 1e6).toString().padStart(6, "0")}`, salesOwnerId: 我.id } });
      await db.followUp.create({ data: { type: "PHONE", title: `${前缀}电话`, content: "问了报价", customerId: c.id, ownerId: 我.id } });
      await db.opportunity.create({ data: { name: `${前缀}商机·${名.slice(-3)}`, customerId: c.id, amount: 1000, stage: "需求确认", status: "OPEN", probability: 30, ownerId: 我.id } });
    }
  } finally {
    await db.$disconnect();
  }
});

test.afterAll(收拾);

test("跟进记录：所属客户下面一行公司，没公司只一行；按公司名搜得到", async ({ page }) => {
  await 登录(page);
  await page.goto(`/follow-ups?keyword=${encodeURIComponent(前缀)}`);
  const 有 = page.locator(".ant-table-row", { hasText: `${前缀}·王建国` });
  const 没 = page.locator(".ant-table-row", { hasText: `${前缀}·李没公司` });
  await expect(有).toBeVisible();
  await expect(没).toBeVisible();

  const 公司行 = 有.locator(".cust-link-co");
  await expect(公司行).toHaveText(公司);
  await expect(公司行).toHaveAttribute("title", 公司);
  // 第二行在人名下面，不是挤在同一行
  const 名框 = (await 有.getByRole("link", { name: `${前缀}·王建国` }).boundingBox())!;
  const 公司框 = (await 公司行.boundingBox())!;
  expect(公司框.y).toBeGreaterThanOrEqual(名框.y + 名框.height - 1);
  // 长公司名一行省略，不撑破这一格
  expect(await 公司行.evaluate((e) => getComputedStyle(e).whiteSpace)).toBe("nowrap");
  await expect(没.locator(".cust-link-co")).toHaveCount(0);

  // 只按公司名搜：只剩有公司的那位
  await expect(page.getByPlaceholder(/^标题 \/ 内容 \/ .+ \/ .+$/)).toBeVisible();
  await page.goto(`/follow-ups?keyword=${encodeURIComponent("临沂佳盈国际食品")}`);
  await expect(page.locator(".ant-table-row", { hasText: `${前缀}·王建国` })).toBeVisible();
  await expect(page.locator(".ant-table-row", { hasText: `${前缀}·李没公司` })).toHaveCount(0);
});

test("商机列表：所属客户同样两行，按公司名搜得到", async ({ page }) => {
  await 登录(page);
  await page.goto(`/opportunities?keyword=${encodeURIComponent("临沂佳盈国际食品")}`);
  const 行 = page.locator(".ant-table-row", { hasText: `${前缀}·王建国` });
  await expect(行).toBeVisible();
  await expect(行.locator(".cust-link-co")).toHaveText(公司);
  await expect(page.locator(".ant-table-row", { hasText: `${前缀}·李没公司` })).toHaveCount(0);
});
