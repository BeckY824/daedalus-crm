/**
 * 商机阶段名自己改（2026-10-21）：老板在设置 → 业务配置里把五个阶段都改成 6 个字（上限），
 * Windows 常见的 1280 / 1366 宽下，看板漏斗、管道列头、商机列表的阶段标签都不撑破、不折行、不被切。
 * 配超长公司名、商机名一起看。跑完把阶段名改回空（原名），不影响后面的用例。
 *
 * 截图写到 E2E_SHOT_DIR（不给就不截）
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";
import { 查排版, 说问题 } from "./layout-audit";

const 管理员 = { 用户名: "admin", 密码: "admin123" };
const 新名 = { 初步沟通: "客户初次接洽", 需求确认: "现场勘查测量", 方案报价: "出设计方案书", 谈判审核: "招投标与议价", 赢单成交: "中标签约完成" };
const 客户名 = "阶段名测试·上海浦东新区张江高科技园区智慧照明工程与室内外景观亮化设计施工一体化有限公司";
const 商机名 = "阶段名测试·张江科学城二期地下车库与园区道路智慧路灯改造及配套监控系统采购安装项目";
const 截图目录 = process.env.E2E_SHOT_DIR;

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

async function 填阶段名(page: Page, 名: Record<string, string>) {
  await page.goto("/settings");
  await page.getByRole("tab", { name: "业务配置" }).click();
  const 面板 = page.getByRole("tabpanel", { name: "业务配置" });
  const 区 = 面板.getByTestId("stage-labels");
  await expect(区).toBeVisible();
  for (const [i, v] of Object.keys(新名).entries()) await 区.getByLabel(`第 ${i + 1} 步 · ${v}`, { exact: true }).fill(名[v] ?? "");
  await 面板.getByRole("button", { name: /^保\s*存$/ }).click();
  await expect(page.getByText("已保存，全站措辞已更新")).toBeVisible({ timeout: 15_000 });
  return 区;
}

/** 只管带阶段名的问题：别的页面块有没有毛病不归这条用例 */
async function 量(page: Page, 范围?: string) {
  const 问题 = (await 查排版(page, { 范围 })).filter((x) => Object.values(新名).some((n) => x.字.includes(n)));
  expect(问题, 说问题(问题)).toEqual([]);
}

test.beforeAll(async () => {
  const db = 连库();
  try {
    await db.customer.deleteMany({ where: { name: 客户名 } });
    const owner = await db.user.findFirstOrThrow({ where: { active: true } });
    const c = await db.customer.create({ data: { name: 客户名, phone: "13755550093", salesOwnerId: owner.id, channelOwnerId: owner.id } });
    for (const [i, stage] of Object.keys(新名).slice(0, 4).entries())
      await db.opportunity.create({ data: { name: `${商机名}${i ? `（${i + 1} 期）` : ""}`, customerId: c.id, ownerId: owner.id, amount: 1280000 + i, stage } });
  } finally {
    await db.$disconnect();
  }
});

test.afterAll(async () => {
  const db = 连库();
  await db.customer.deleteMany({ where: { name: 客户名 } });
  await db.$disconnect();
});

for (const 宽 of [1280, 1366]) {
  test(`${宽} 宽：六个字的阶段名在漏斗、管道、商机列表都放得下`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 宽, height: 800 });
    await 登录(page);
    const 截 = async (名: string) => { if (截图目录) await page.screenshot({ path: `${截图目录}/阶段名-${宽}-${名}.png` }); };
    try {
      const 区 = await 填阶段名(page, 新名);
      await 区.scrollIntoViewIfNeeded();
      await 截("设置");

      await page.goto("/dashboard");
      const 漏斗 = page.locator(".funnel-row").first();
      await expect(漏斗).toContainText(新名.初步沟通);
      await 漏斗.scrollIntoViewIfNeeded();
      for (const n of Object.values(新名)) {
        const 字 = page.locator(".funnel-row span", { hasText: n });
        const h = await 字.evaluate((el) => el.getBoundingClientRect().height);
        expect(h, `漏斗「${n}」折行了`).toBeLessThan(26);
      }
      if (截图目录) await 漏斗.locator("xpath=ancestor::div[contains(@class,'ant-card')][1]").screenshot({ path: `${截图目录}/阶段名-${宽}-看板漏斗.png` });
      await 量(page);

      await page.goto("/opportunities/pipeline");
      await expect(page.locator(".pipe-h b").first()).toHaveText(新名.初步沟通);
      await 截("管道");
      await 量(page);

      await page.goto(`/opportunities?keyword=${encodeURIComponent("阶段名测试")}`);
      await expect(page.locator(".ant-table-row").first()).toBeVisible();
      await expect(page.getByText(新名.谈判审核).first()).toBeVisible();
      await 截("商机列表");
      await 量(page);
    } finally {
      await 填阶段名(page, {});
    }
  });
}
