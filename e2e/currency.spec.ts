/**
 * 全站币种（2026-10-03）：建一个美元商机 → 登记签约时币种和金额跟着带 → 列表、记录页、数据页都按币种写。
 * 不换汇：同一个月有人民币也有美元时，数据页给「按币种看」，不把两种钱加成一个数。
 *
 * 这一组造的客户在 afterAll 里删掉（签约、商机跟着级联删）：库和后面的用例共用，
 * 后面有按「¥」断言合计的（duplicate、smoke），留一笔美元在库里它们会看到两种币。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";

const 管理员 = { 用户名: "admin", 密码: "admin123" };
const 客户名 = "币种测试客户";
const 人民币客户 = "币种测试人民币客户";

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

/** antd 下拉：点开、敲字、回车选第一个 */
async function 选(page: Page, 框: ReturnType<Page["getByLabel"]>, 字: string) {
  await 框.click();
  await 框.fill(字);
  await page.keyboard.press("Enter");
}

let 客户id = "";

test.beforeAll(async () => {
  const db = 连库();
  try {
    await db.customer.deleteMany({ where: { name: { in: [客户名, 人民币客户] } } });
    const owner = await db.user.findFirstOrThrow({ where: { active: true } });
    客户id = (await db.customer.create({ data: { name: 客户名, phone: "13755550001", salesOwnerId: owner.id, channelOwnerId: owner.id } })).id;
    // 同一个月再有一笔人民币签约：数据页才会出「按币种看」
    const 另一位 = await db.customer.create({ data: { name: 人民币客户, phone: "13755550002", salesOwnerId: owner.id, channelOwnerId: owner.id } });
    const k = await db.contract.create({ data: { customerId: 另一位.id, amount: 19800, signedAt: new Date() } });
    await db.contractMoney.create({ data: { contractId: k.id, currency: "CNY", amountExact: 19800 } });
  } finally {
    await db.$disconnect();
  }
});

test.afterAll(async () => {
  const db = 连库();
  await db.customer.deleteMany({ where: { name: { in: [客户名, 人民币客户] } } });
  await db.$disconnect();
});

test("美元商机 → 登记签约带上币种 → 列表、记录页、数据页都写美元", async ({ page }) => {
  await 登录(page);

  // 1. 新建商机，选美元、带分
  await page.goto("/opportunities");
  await page.getByRole("button", { name: /新建商机/ }).first().click();
  const 框 = page.getByRole("dialog", { name: "新建商机" });
  await 框.getByLabel("商机名称").fill("美元询盘");
  await 选(page, 框.getByLabel("所属客户"), 客户名);
  // 管理员不在负责人候选里：负责人留空、自己选，不再默认名单第一人（2026-10-04 T-025）
  await 框.getByLabel("负责人", { exact: true }).click();
  // 上一个下拉（所属客户）可能还没收起：按选项文字点，别按「第一个展开的下拉」找
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option", { hasText: "张三" }).first().click();
  await 选(page, 框.getByLabel("币种"), "USD");
  await 框.getByLabel("商机金额").fill("3250.5");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框).toBeHidden();
  const 行 = page.locator(".ant-table-row", { hasText: "美元询盘" });
  await expect(行).toContainText("US$ 3,250.50");

  // 2. 登记签约：勾着的商机是美元，金额和币种都跟着带
  await page.goto(`/customers/${客户id}`);
  await page.getByRole("button", { name: /登记签约/ }).first().click();
  const 签 = page.getByRole("dialog", { name: "登记签约" });
  await expect(签.getByLabel("签约金额", { exact: true })).toHaveValue("3,250.5");
  // 框里只显示代码，悬停提示是中文名（CurrencySelect 的 labelRender）
  await expect(签.getByTitle("美元").first()).toHaveText("USD");
  await 签.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText(/签约已记录，同时：1 个商机标为赢单/)).toBeVisible();
  await expect(page.locator("main").getByText("US$ 3,250.50").first()).toBeVisible();

  // 3. 数据页「本月」：两种币 → 有切换；默认看本位币（人民币），切到美元只算美元
  await page.goto("/overview?view=本月");
  const 切换 = page.locator(".reports-cur");
  await expect(切换).toBeVisible();
  await expect(切换).toContainText("这一段共签");
  await expect(切换).toContainText("US$ 3,250.50");
  await 切换.getByText("USD", { exact: true }).click();
  await page.waitForURL(/currency=USD/);
  await expect(page.locator(".stat-card", { hasText: "签约总额" })).toContainText("US$ 3,250.50");

  // 4. 数据页「现在」：本月签约那张卡两种币并排写，不加成一个数
  await page.goto("/overview?view=现在");
  const 卡 = page.locator(".stat-card", { hasText: "本月签约" });
  await expect(卡).toContainText("US$ 3,250.50");
  await expect(卡).toContainText("¥");
});
