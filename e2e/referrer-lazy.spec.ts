/**
 * 「推荐人 → 已有客户」的候选改成表单打开才取（2026-10-20）之后，下拉还和原来一样能用，而且慢的时候不是空的。
 *
 * 原来客户列表页、详情页出页时就把全部客户塞进页面数据（1 万客户时几百 KB）。现在：
 *   1. 页面数据里不再有不相干的客户
 *   2. 新建：选「已有客户」，搜得到、选得上
 *   3. 编辑：原来的推荐人名字立刻显示，候选还没回来也不会变成一串 id
 *   4. 取得慢：下拉里转圈写「正在取」，不出「暂无数据」；回来以后照常能选
 *   5. 最窄的桌面窗口（1024×700）和手机宽度（390）各走一遍新建
 * 手机伴侣（/m）的新建客户本来就没有推荐人这一格，不受影响。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";

const 推荐人 = { id: "e2e-lazy-ref-parent", name: "懒取推荐人甲" };
const 被推荐 = { id: "e2e-lazy-ref-child", name: "懒取被推荐乙" };
/** 和推荐没关系的一位：看他的详情页里有没有夹带别人 */
const 路人 = { id: "e2e-lazy-ref-other", name: "懒取路人丙" };
const 三位 = [被推荐.id, 推荐人.id, 路人.id];
/** 详情页中栏的名单摆最近跟进的 50 位：垫 55 位最近跟进过的，推荐人甲就轮不上名单，详情页里出现它只能是「全量候选」带进来的 */
const 垫 = Array.from({ length: 55 }, (_, i) => ({ id: `e2e-lazy-ref-pad-${i}`, name: `垫底路人${i}` }));
const 全部 = [...三位, ...垫.map((c) => c.id)];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const db = 连库();
  try {
    const owner = (await db.user.findUniqueOrThrow({ where: { email: "zhangsan" } })).id;
    await db.customer.deleteMany({ where: { id: { in: 全部 } } });
    // 建档时间放得很早：按建档倒序的列表第一页轮不到它，页面数据里出现它只能是「全量候选」带进来的
    await db.customer.create({ data: { ...推荐人, phone: "", salesOwnerId: owner, createdAt: new Date("2001-01-01T00:00:00Z") } });
    await db.customer.create({ data: { ...被推荐, phone: "", salesOwnerId: owner, referrerCustomerId: 推荐人.id, createdAt: new Date("2001-01-02T00:00:00Z") } });
    await db.customer.create({ data: { ...路人, phone: "", salesOwnerId: owner, lastFollowAt: new Date() } });
    await db.customer.createMany({ data: 垫.map((c) => ({ ...c, phone: "", salesOwnerId: owner, lastFollowAt: new Date() })) });
  } finally {
    await db.$disconnect();
  }
});

test.afterAll(async () => {
  const db = 连库();
  try {
    await db.customer.deleteMany({ where: { id: { in: 全部 } } });
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

/** 把 server action（POST + next-action 头）卡住，直到 放开()。只卡这一页上的 */
async function 卡住服务端(page: Page) {
  let 放开!: () => void;
  const 闸 = new Promise<void>((r) => (放开 = r));
  let 卡了 = 0;
  await page.route("**/*", async (route) => {
    const r = route.request();
    if (r.method() === "POST" && r.headers()["next-action"]) {
      卡了++;
      await 闸;
    }
    await route.continue();
  });
  return { 放开: () => 放开(), 卡了: () => 卡了 };
}

const 下拉 = (page: Page) => page.locator(".ant-select-dropdown:visible");

async function 新建时选推荐人(page: Page) {
  await page.goto("/customers");
  const { 放开, 卡了 } = await 卡住服务端(page);
  await page.getByRole("button", { name: /新建/ }).first().click();
  const 表单 = page.getByRole("dialog", { name: /新建/ });
  await expect(表单).toBeVisible();
  await 表单.getByText(/^已有/).click();
  await expect.poll(卡了).toBeGreaterThan(0);

  await 表单.locator("#referrerCustomerId").click();
  // 还没回来：转圈 + 「正在取」，不是空白的「暂无数据」
  await expect(下拉(page)).toContainText(/正在取.*名单/);
  await expect(下拉(page)).not.toContainText("暂无数据");

  放开();
  await 表单.locator("#referrerCustomerId").fill("懒取推荐人");
  const 选项 = 下拉(page).locator(".ant-select-item-option-content");
  await expect(选项).toHaveText([推荐人.name]);
  await 选项.first().click();
  // antd v6 的选中项类名是 ant-select-content-has-value
  await expect(表单.locator(".ant-select-content-has-value", { hasText: 推荐人.name })).toBeVisible();
}

test("页面数据里不再带全部客户", async ({ page }) => {
  await 登录(page);
  // 搜一个谁都对不上的词：列表是空的，原来页面数据里照样有全量候选
  // 直接要整页（HTML 里带着 RSC 数据），用这一页登录后的 cookie
  const 列表 = await page.request.get("/customers?keyword=" + encodeURIComponent("对不上的词zz"));
  expect(列表.ok()).toBe(true);
  expect(await 列表.text()).not.toContain(推荐人.name);
  // 不相干那位的详情页：原来带着「除了自己以外的全部客户」
  const 详情 = await page.request.get(`/customers/${路人.id}`);
  expect(详情.ok()).toBe(true);
  const 详情页 = await 详情.text();
  expect(详情页).toContain("编辑全部");
  expect(详情页).not.toContain(推荐人.name);
});

test("新建：候选取得慢也不空，回来以后能搜能选", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await 登录(page);
  await 新建时选推荐人(page);
});

test("编辑：原来的推荐人立刻显示名字，候选回来后不变、排除自己", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await 登录(page);
  await page.goto(`/customers/${被推荐.id}`);
  const { 放开 } = await 卡住服务端(page);
  await page.getByRole("button", { name: "编辑全部" }).click();
  const 表单 = page.getByRole("dialog", { name: /编辑/ });
  await expect(表单).toBeVisible();
  const 已选 = 表单.locator(".ant-select-content-has-value", { hasText: 推荐人.name });
  await expect(已选).toBeVisible();
  await expect(表单).not.toContainText(推荐人.id);

  放开();
  await 表单.locator("#referrerCustomerId").fill("懒取");
  const 选项 = 下拉(page).locator(".ant-select-item-option-content");
  // 自己（懒取被推荐乙）不在候选里，推荐人只出现一次
  await expect.poll(async () => (await 选项.allTextContents()).sort()).toEqual([推荐人.name, 路人.name].sort());
  await page.keyboard.press("Escape");
  await expect(已选).toBeVisible();
});

for (const 尺寸 of [
  { 名: "最窄的桌面窗口", width: 1024, height: 700 },
  { 名: "手机宽度", width: 390, height: 844 },
]) {
  test(`${尺寸.名}（${尺寸.width}）：新建时一样能选推荐人`, async ({ page }) => {
    await page.setViewportSize({ width: 尺寸.width, height: 尺寸.height });
    await 登录(page);
    await 新建时选推荐人(page);
  });
}
