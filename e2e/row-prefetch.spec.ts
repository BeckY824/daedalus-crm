/**
 * 列表每一行上的链接不预取，左栏导航照旧预取（2026-10-20，components/ui.tsx 的 RowLink）。
 *
 * next/link 一进视口就预取：客户表格 + 中栏名单一屏几十行，原来每行都去取一遍详情页。
 * 预取只在生产构建里发生（next dev 不预取），所以这条只在 E2E_PROD=1 下跑——CI 就是这么跑的。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";

test.skip(process.env.E2E_PROD !== "1", "next dev 不预取，只在生产构建里看得出来");

/** 垫 30 位：一屏铺满行，单独跑这一条时库里也够看 */
const 垫 = Array.from({ length: 30 }, (_, i) => ({ id: `e2e-row-prefetch-${i}`, name: `预取垫底${i}` }));
test.beforeAll(async () => {
  const db = 连库();
  try {
    const owner = (await db.user.findUniqueOrThrow({ where: { email: "zhangsan" } })).id;
    await db.customer.deleteMany({ where: { id: { in: 垫.map((c) => c.id) } } });
    await db.customer.createMany({ data: 垫.map((c) => ({ ...c, phone: "", salesOwnerId: owner, lastFollowAt: new Date() })) });
  } finally {
    await db.$disconnect();
  }
});
test.afterAll(async () => {
  const db = 连库();
  try {
    await db.customer.deleteMany({ where: { id: { in: 垫.map((c) => c.id) } } });
  } finally {
    await db.$disconnect();
  }
});

async function 登录(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("用户名").fill("zhangsan");
  await page.getByPlaceholder("登录密码").fill("admin123");
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await page.waitForURL(/\/dashboard/);
}

test("客户列表：行上的详情页一个都不预取，左栏照旧预取", async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1000 });
  await 登录(page);
  const 预取: string[] = [];
  page.on("request", (r) => {
    if (r.headers()["next-router-prefetch"]) 预取.push(new URL(r.url()).pathname);
  });
  await page.goto("/customers");
  const 行 = page.locator("a[href^='/customers/']");
  // 表格和中栏名单都摆出来了，行上的链接在视口里
  await expect.poll(() => 行.count()).toBeGreaterThan(5);
  // 左栏导航的预取到了，说明预取本身是开着的，这时候看行上的有没有跟着取
  await expect.poll(() => 预取.filter((p) => !p.startsWith("/customers/")).length, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  expect(预取.filter((p) => /^\/customers\/(?!recent$)[^/]+$/.test(p)), "行上的客户详情页被预取了").toEqual([]);

  // 点一行照常进详情
  const 第一位 = page.locator("table a[href^='/customers/']").first();
  const 去 = await 第一位.getAttribute("href");
  await 第一位.click();
  await page.waitForURL((u) => u.pathname === 去);
});
