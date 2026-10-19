/**
 * 商机名称框和备注一样大（客户反馈 2026-10-19）：外贸客户常把询盘要求整段写进商机名，
 * 原来一行的框只看得到开头。现在两行起、随内容长高；名称仍是一行字——回车不换行，粘进来的换行并成空格。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";

const 管理员 = { 用户名: "admin", 密码: "admin123" };
const 客户名 = "长商机名测试客户";
const 原名 = "长商机名测试";
const 长名 =
  "frozen chicken and chicken legs. Annual buying quantity is minimum 50.000 tons of frozen chicken legs and 10.000 tons of whole chicken, " +
  "Halal certificate required, CIF Mersin, payment L/C at sight, first trial order 5 x 40ft containers, packing 10kg/carton";

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

test.beforeAll(async () => {
  const db = 连库();
  try {
    await db.customer.deleteMany({ where: { name: 客户名 } });
    const owner = await db.user.findFirstOrThrow({ where: { active: true } });
    const c = await db.customer.create({ data: { name: 客户名, phone: "13755550091", salesOwnerId: owner.id, channelOwnerId: owner.id } });
    await db.opportunity.create({ data: { name: 原名, customerId: c.id, ownerId: owner.id, amount: 0, stage: "初步沟通" } });
  } finally {
    await db.$disconnect();
  }
});

test.afterAll(async () => {
  const db = 连库();
  await db.customer.deleteMany({ where: { name: 客户名 } });
  await db.$disconnect();
});

test("商机名称两行起、随内容长高；回车和粘进来的换行都不进名称", async ({ page }) => {
  await 登录(page);
  await page.goto(`/opportunities?keyword=${encodeURIComponent(原名)}`);
  const 框 = page.getByRole("dialog", { name: "编辑商机" });
  const 名字 = page.locator(".ant-table-row").getByRole("button", { name: 原名, exact: true });
  await expect(async () => {
    if (!(await 框.isVisible())) await 名字.click();
    await expect(框).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  const 名 = 框.getByLabel("商机名称");
  await expect(名).toHaveValue(原名);

  // 两行起：和备注差不多高
  const 空高 = (await 名.boundingBox())!.height;
  const 备注高 = (await 框.getByLabel("备注").boundingBox())!.height;
  expect(空高).toBeGreaterThanOrEqual(备注高 - 4);

  // 一大段要求：框跟着长高，整段看得到，弹框不横滚
  await 名.fill(`${长名}\n  second line from email`);
  await 名.press("End");
  await 名.press("Enter");
  await expect(名).toHaveValue(`${长名} second line from email`);
  expect((await 名.boundingBox())!.height).toBeGreaterThan(空高);
  expect(await 名.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框).toBeHidden();
  const db = 连库();
  try {
    const o = await db.opportunity.findFirstOrThrow({ where: { customer: { name: 客户名 } } });
    expect(o.name).toBe(`${长名} second line from email`);
  } finally {
    await db.$disconnect();
  }
});
