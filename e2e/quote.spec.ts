/**
 * 报价明细（2026-10-03 外贸第 3 块）：商机框里填明细 → 金额跟着合计 → 再打开明细还在 →
 * 客户页有「报价记录」→ 同一位客户再建商机、填同一个产品，提示上次报的价、点一下填进单价。
 *
 * 造的客户 afterAll 删掉（商机、报价级联删）：库和后面的用例共用。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";
import { 报价明细 } from "../src/lib/features";

test.skip(!报价明细, "报价明细这一版不上");

const 管理员 = { 用户名: "admin", 密码: "admin123" };
const 客户名 = "报价测试客户";

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
      /* dev 模式下第一次点击可能落空，再试 */
    }
  }
  throw new Error("登录失败");
}

let 客户id = "";

test.beforeAll(async () => {
  const db = 连库();
  try {
    await db.customer.deleteMany({ where: { name: 客户名 } });
    const owner = await db.user.findFirstOrThrow({ where: { active: true } });
    客户id = (await db.customer.create({ data: { name: 客户名, phone: "13755550011", salesOwnerId: owner.id, channelOwnerId: owner.id } })).id;
  } finally {
    await db.$disconnect();
  }
});

test.afterAll(async () => {
  const db = 连库();
  await db.customer.deleteMany({ where: { name: 客户名 } });
  await db.$disconnect();
});

async function 开新建框(page: Page, 名称: string) {
  await page.goto("/opportunities");
  await page.getByRole("button", { name: /新建商机/ }).first().click();
  const 框 = page.getByRole("dialog", { name: "新建商机" });
  await 框.getByLabel("商机名称").fill(名称);
  await 框.getByLabel("所属客户").click();
  await 框.getByLabel("所属客户").fill(客户名);
  await page.keyboard.press("Enter");
  /*
    库里不止一个人时「负责人」那一格要选（2026-10-04 T-025 起管理员建商机不再默认记到名单第一人）。
    这份用例跟着报价明细开关一直跳过，没跟上——10-06 开关矩阵抓到
  */
  const 负责人 = 框.getByLabel("负责人");
  if (await 负责人.count()) {
    // 打开下拉、回车选第一个（下拉刚开时第一项是激活的）
    await 负责人.click();
    await page.keyboard.press("Enter");
    await expect(框.locator(".ant-form-item-explain-error", { hasText: "负责人" })).toHaveCount(0);
  }
  return 框;
}

test("报价明细：金额跟着合计、再开还在、客户页有记录、下次提示上次的价", async ({ page }) => {
  await 登录(page);

  // 1. 新建商机，填两行明细；金额自动等于合计
  const 框 = await 开新建框(page, "面板灯询盘");
  await 框.getByRole("button", { name: /加报价明细/ }).click();
  await expect(框.getByLabel("第 1 行产品")).toBeFocused();
  await 框.getByLabel("第 1 行产品").fill("LED 面板灯");
  await 框.getByLabel("第 1 行规格").fill("60×60");
  await 框.getByLabel("第 1 行数量").fill("2000");
  await 框.getByLabel("第 1 行单价").fill("3.2");
  await 框.getByRole("button", { name: /加一行/ }).click();
  await 框.getByLabel("第 2 行产品").fill("安装支架");
  await 框.getByLabel("第 2 行数量").fill("2000");
  await 框.getByLabel("第 2 行单价").fill("0.35");
  await 框.getByLabel("第 2 行单价").blur();
  await expect(框.locator(".qt-foot")).toContainText("7,100");
  await expect(框.getByLabel("商机金额")).toHaveValue("7,100");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框).toBeHidden();
  const 行 = page.locator(".ant-table-row", { hasText: "面板灯询盘" });
  await expect(行).toContainText("7,100");

  // 2. 再打开：明细还在
  await 行.getByRole("button", { name: "编辑 面板灯询盘" }).click();
  const 编辑框 = page.getByRole("dialog", { name: "编辑商机" });
  await expect(编辑框.getByLabel("第 1 行产品")).toHaveValue("LED 面板灯");
  await expect(编辑框.getByLabel("第 2 行单价")).toHaveValue("0.35");
  await 编辑框.getByRole("button", { name: /取\s*消/ }).click();

  // 3. 客户页：报价记录
  await page.goto(`/customers/${客户id}`);
  const 记录 = page.locator(".rec-sec", { hasText: "报价记录" });
  await expect(记录).toContainText("LED 面板灯");
  await expect(记录).toContainText("× 2000");

  // 4. 同一位客户再建一个商机，填同一个产品：提示上次的价，点一下填进单价
  const 框2 = await 开新建框(page, "面板灯返单");
  await 框2.getByRole("button", { name: /加报价明细/ }).click();
  await 框2.getByLabel("第 1 行产品").fill("led 面板灯");
  await 框2.getByLabel("第 1 行数量").click();
  const 提示 = 框2.locator(".qt-hint");
  await expect(提示).toContainText("上次报这个客户");
  await expect(提示).toContainText("面板灯询盘");
  await 提示.getByRole("button", { name: "用这个价" }).click();
  await expect(框2.getByLabel("第 1 行单价")).toHaveValue("3.2");
  await 框2.getByRole("button", { name: /取\s*消/ }).click();
});
