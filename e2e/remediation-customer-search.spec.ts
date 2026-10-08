import { test, expect, type Page } from "@playwright/test";
import { 连库, 清空业务数据 } from "./mock-data";
let target: string;
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const db = 连库();
  try {
    await 清空业务数据(db); const u = await db.user.findUniqueOrThrow({ where: { email: "zhangsan" } });
    await db.customer.createMany({ data: Array.from({ length: 1001 }, (_, n) => ({ id: `e2e-search-${n}`, name: n === 1000 ? "QA远端目标" : `QA客户${n}`, school: `QA公司${n}`, phone: `138${String(n).padStart(8, "0")}`, salesOwnerId: u.id, createdAt: new Date(2026, 0, 1) })) }); target = "e2e-search-1000";
  } finally { await db.$disconnect(); }
});
test.afterAll(async () => { const db = 连库(); try { await 清空业务数据(db); } finally { await db.$disconnect(); } });
async function login(page: Page) {
  await page.goto("/login"); await page.getByPlaceholder("用户名").fill("zhangsan"); await page.getByPlaceholder("登录密码").fill("admin123"); await page.getByRole("button", { name: /登\s*录/ }).click(); await page.waitForURL(/\/dashboard/);
}
test("生产冷加载new=1预填第1001位，无水合错误、取消不写入且参数被消费", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => { errors.push(page.url() + " " + e.message); console.log("QA页面异常", page.url(), e.message); }); await login(page);
  await page.goto(`/opportunities?new=1&customer=${target}`);
  const dialog = page.getByRole("dialog", { name: "新建商机" }); await expect(dialog).toBeVisible();
  await expect(dialog.locator(".ant-select").filter({ has: page.locator("#customerId") })).toContainText("QA远端目标");
  await dialog.locator("#name").fill("未保存的商机"); await dialog.getByRole("button", { name: /取\s*消/ }).click(); await expect(dialog).toBeHidden();
  expect(new URL(page.url()).searchParams.has("new")).toBe(false);
  const db = 连库(); try { expect(await db.opportunity.count()).toBe(0); } finally { await db.$disconnect(); }
  expect(errors).toEqual([]);
});
test("客户详情内就地新建商机，客户正确预填并实际保存到该客户", async ({ page }) => {
  await login(page); await page.goto(`/customers/${target}`); await page.getByRole("button", { name: "新建关联商机" }).click();
  const dialog = page.getByRole("dialog", { name: "新建商机" }); await expect(dialog).toBeVisible();
  await expect(dialog.locator(".ant-select").filter({ has: page.locator("#customerId") })).toContainText("QA远端目标");
  await dialog.locator("#name").fill("详情就地商机"); await dialog.getByRole("spinbutton", { name: "商机金额" }).fill("123"); await dialog.getByRole("button", { name: /保\s*存/ }).click();
  await expect(dialog).toBeHidden(); await expect(page.getByRole("main").getByText("详情就地商机", { exact: true })).toBeVisible();
  const db = 连库(); try { expect(await db.opportunity.findFirst({ where: { name: "详情就地商机" } })).toMatchObject({ customerId: target, amount: 123 }); } finally { await db.$disconnect(); }
});
test("按唯一ID冷加载已有商机，无水合错误，取消保留列表筛选", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message)); await login(page);
  const db = 连库(); let id: string;
  try { id = (await db.opportunity.findFirstOrThrow({ where: { name: "详情就地商机" } })).id; } finally { await db.$disconnect(); }
  await page.goto(`/opportunities?opportunity=${id}&keyword=不存在的列表词&status=OPEN`);
  const dialog = page.getByRole("dialog", { name: "编辑商机" }); await expect(dialog).toBeVisible();
  await expect(dialog.locator("#name")).toHaveValue("详情就地商机");
  await dialog.getByRole("button", { name: /取\s*消/ }).click(); await expect(dialog).toBeHidden();
  const url = new URL(page.url()); expect(url.searchParams.has("opportunity")).toBe(false);
  expect(url.searchParams.get("keyword")).toBe("不存在的列表词"); expect(url.searchParams.get("status")).toBe("OPEN");
  expect(errors).toEqual([]);
});
test("联系人按公司远程搜索第1001位并保存，打开下拉最多8项", async ({ page }) => {
  await login(page); await page.goto("/contacts"); await page.getByRole("button", { name: /添加联系人/ }).click();
  const dialog = page.getByRole("dialog"); const input = dialog.locator("#customerId"); await input.click();
  await expect.poll(() => page.locator(".ant-select-dropdown:visible .ant-select-item-option").count()).toBe(8);
  await input.fill("QA公司1000"); const choice = page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "QA公司1000" }); await expect(choice).toHaveCount(1); await choice.click();
  await dialog.locator("#name").fill("远程选择联系人"); await dialog.getByRole("button", { name: /保\s*存/ }).click(); await expect(dialog).toBeHidden();
  const db = 连库(); try { expect(await db.contact.findFirst({ where: { name: "远程选择联系人" } })).toMatchObject({ customerId: target }); } finally { await db.$disconnect(); }
});
