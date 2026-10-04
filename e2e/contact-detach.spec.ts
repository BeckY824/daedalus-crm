/**
 * 联系人「只移出、不删」（2026-10-01 用户反馈：在客户详情里删联系人，联系人页里也跟着没了）。
 *
 * 走一遍人会走的路：客户详情点删除 → 问只移出还是彻底删 → 撤销 → 再移出 →
 * 联系人页里写「未归属」→ 点开挂到别的客户下面。彻底删也能撤销。
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

let 甲 = "";

test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  const 张三 = await p.user.findFirstOrThrow({ where: { email: 账号.用户名 } });
  const a = await p.customer.create({ data: { name: "移出测试甲", phone: "13811110001", salesOwnerId: 张三.id } });
  await p.customer.create({ data: { name: "移出测试乙", phone: "13811110002", salesOwnerId: 张三.id } });
  await p.contact.create({ data: { customerId: a.id, name: "王经理", phone: "13911110001", isPrimary: true } });
  甲 = a.id;
  await p.$disconnect();
});

test.afterAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await p.$disconnect();
});

/** 联系人那一小块里王经理那行的删除钮（平时藏着，悬停才出来） */
async function 点删除(page: Page) {
  const 行 = page.locator(".rec-mini", { hasText: "王经理" });
  await 行.hover();
  await 行.getByRole("button", { name: "删除联系人 王经理" }).click();
  const 框 = page.getByRole("dialog");
  await expect(框).toContainText("把「王经理」从这位");
  return 框;
}

test("客户详情：只移出、撤销、再移出", async ({ page }) => {
  await 登录(page);
  await page.goto(`/customers/${甲}`);
  const 联系人块 = page.locator(".rec-sec", { hasText: "添加联系人" });
  await expect(联系人块).toContainText("王经理");

  let 框 = await 点删除(page);
  // 主钮是更不伤数据的那个
  await expect(框.getByRole("button", { name: "只移出" })).toBeFocused();
  await 框.getByRole("button", { name: "只移出" }).click();
  const 提示 = page.locator(".ant-message").getByText("「王经理」已移出，联系人页里还留着");
  await expect(提示).toBeVisible();
  await expect(联系人块).toContainText("还没有联系人");

  await page.locator(".ant-message").getByRole("button", { name: "撤销" }).click();
  await expect(page.locator(".ant-message").getByText("「王经理」回来了")).toBeVisible();
  await expect(联系人块).toContainText("王经理");
  // 关键联系人原样回来
  await expect(page.locator(".rec-mini", { hasText: "王经理" })).toContainText("关键");

  框 = await 点删除(page);
  await 框.getByRole("button", { name: "只移出" }).click();
  await expect(联系人块).toContainText("还没有联系人");
});

test("联系人页：写「未归属」，点开挂到别的客户下面", async ({ page }) => {
  await 登录(page);
  await page.goto("/contacts");
  const 行 = page.locator("tr.ant-table-row", { hasText: "王经理" });
  await expect(行).toContainText("未归属");

  await 行.click();
  const 框 = page.getByRole("dialog");
  await expect(框).toContainText("编辑联系人 · 王经理");
  await expect(框).toContainText("现在不在任何");
  await 框.getByRole("combobox").first().click();
  await page.locator(".ant-select-dropdown").getByText("移出测试乙", { exact: true }).click();
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.locator(".ant-message").getByText("已挂到「移出测试乙」")).toBeVisible();
  await expect(行).toContainText("移出测试乙");
  await expect(行).not.toContainText("未归属");
});

test("彻底删除也能撤销", async ({ page }) => {
  const p = 连库();
  await p.contact.create({ data: { customerId: 甲, name: "王经理", phone: "13911110003" } });
  await p.$disconnect();

  await 登录(page);
  await page.goto(`/customers/${甲}`);
  const 框 = await 点删除(page);
  await 框.getByRole("button", { name: "彻底删除" }).click();
  await expect(page.locator(".ant-message").getByText("「王经理」已删除")).toBeVisible();
  const 联系人块 = page.locator(".rec-sec", { hasText: "添加联系人" });
  await expect(联系人块).toContainText("还没有联系人");

  await page.locator(".ant-message").getByRole("button", { name: "撤销" }).click();
  await expect(联系人块).toContainText("王经理");
});

test("添加联系人挑所属客户：两位同名客户，下拉里看得出公司和手机尾号，挂到挑的那位（2026-10-04 J-016）", async ({ page }) => {
  const p = 连库();
  const 张三 = await p.user.findFirstOrThrow({ where: { email: 账号.用户名 } });
  await p.customer.create({ data: { name: "重名王强", phone: "13822220011", school: "星辰科技", salesOwnerId: 张三.id } });
  const 海川 = await p.customer.create({ data: { name: "重名王强", phone: "13922220022", school: "海川外贸", salesOwnerId: 张三.id } });

  await 登录(page);
  await page.goto("/contacts");
  await page.getByRole("button", { name: "添加联系人" }).click();
  const 框 = page.getByRole("dialog");
  await 框.getByRole("combobox").first().click();
  const 下拉 = page.locator(".ant-select-dropdown");
  await expect(下拉.getByText("重名王强（星辰科技 · 尾号 0011）", { exact: true })).toBeVisible();
  await 下拉.getByText("重名王强（海川外贸 · 尾号 0022）", { exact: true }).click();
  await 框.getByPlaceholder("张经理").fill("采购刘");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框).toBeHidden();

  const 建的 = await p.contact.findFirstOrThrow({ where: { name: "采购刘" } });
  expect(建的.customerId).toBe(海川.id);
  await p.$disconnect();
});
