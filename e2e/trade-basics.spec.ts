/**
 * 外贸基础五件（2026-10-16，进 0.46.19）在界面上走一遍。单测见 tests/trade-basics.test.ts，跨版本同步见 tests/trade-basics-sync.test.ts。
 *
 *   界面：新建客户填「客户等级」「官网」→ 记录页标签行有等级章、「官网 ↗」、「对方当地 HH:mm」，档案里能行内改等级
 *         客户列表：等级列、按等级筛（含「未分级」）、点表头按等级排；国家下面一行是对方此刻几点；官网收在「列」里
 *         跟进：「记录跟进」的类型下拉里 WhatsApp 排第一
 *   端到端：计划页点 ✓ → 小框（方式默认按计划写的 WhatsApp、一句话、下次默认 7 天后）→ 保存并完成
 *         → 计划没了、记录页时间线多一条 WhatsApp 跟进、排上 7 天后的「接着跟进：…」；
 *         另一条在记录页「下次跟进」上点完成 → 跳过，直接完成 → 和原来一样（提示里有撤销）
 *
 * 模版从「设置 → 业务配置」界面切（设置有进程内缓存，直接改库服务端看不到），结束切回通用销售。数据自己造自己收。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";

const 管理员 = { 用户名: "admin", 密码: "admin123" };
const 前缀 = "外贸基础测试";
const 新客户 = `${前缀}·新建`;

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

/** antd 下拉里点一项：页面上同名的 role=option 有一份是给读屏的隐藏副本，点看得见的那份 */
async function 选(page: Page, 字: string | RegExp) {
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option", { hasText: 字 }).first().click();
}

async function 套预设(page: Page, 名: string) {
  await page.goto("/settings");
  await page.getByRole("tab", { name: "业务配置" }).click();
  const 面板 = page.getByRole("tabpanel", { name: "业务配置" });
  await 面板.getByRole("button", { name: 名, exact: true }).click();
  await 面板.locator(".biz-preset-todo").getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText("已保存，全站措辞已更新")).toBeVisible({ timeout: 15_000 });
}

async function 收拾() {
  const db = 连库();
  try {
    const ids = (await db.customer.findMany({ where: { name: { startsWith: 前缀 } }, select: { id: true } })).map((c) => c.id);
    await db.followPlan.deleteMany({ where: { customerId: { in: ids } } });
    await db.followUp.deleteMany({ where: { customerId: { in: ids } } });
    await db.task.deleteMany({ where: { customerId: { in: ids } } });
    await db.customer.deleteMany({ where: { id: { in: ids } } });
  } finally {
    await db.$disconnect();
  }
}

const ids: Record<string, string> = {};
const 计划: Record<string, string> = {};

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async () => {
  await 收拾();
  const db = 连库();
  try {
    const 我 = await db.user.findFirstOrThrow({ where: { email: 管理员.用户名 } });
    const 建 = async (名: string, extra: { country?: string; level?: string | null; whatsapp: string }) => {
      const c = await db.customer.create({ data: { name: `${前缀}·${名}`, phone: "", salesOwnerId: 我.id } });
      await db.customerExtra.create({ data: { customerId: c.id, ...extra } });
      ids[名] = c.id;
    };
    await 建("甲A", { country: "美国", level: "A", whatsapp: "+1 212 555 0101" });
    await 建("乙C", { country: "德国", level: "C", whatsapp: "+49 151 0000101" });
    await 建("丙空", { country: "日本", level: null, whatsapp: "+81 90 0000 0101" });
    // 两条今天到期的计划：一条在计划页走「保存并完成」，一条在记录页走「跳过，直接完成」
    计划.计划页 = (await db.followPlan.create({ data: { customerId: ids["甲A"], ownerId: 我.id, subject: "发新报价", method: "WhatsApp", plannedAt: new Date(Date.now() - 3600_000) } })).id;
    计划.记录页 = (await db.followPlan.create({ data: { customerId: ids["乙C"], ownerId: 我.id, subject: "问样品反馈", method: "电话沟通", plannedAt: new Date(Date.now() - 3600_000) } })).id;
  } finally {
    await db.$disconnect();
  }
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await 登录(page);
    await 套预设(page, "通用销售");
  } finally {
    await page.close();
    await 收拾();
    const db = 连库();
    await db.setting.deleteMany({ where: { key: "business" } });
    await db.$disconnect();
  }
});

test("界面：新建客户填等级、官网 → 记录页有等级章、官网链接、对方当地时间；档案里行内改等级", async ({ page }) => {
  const 问题: string[] = [];
  page.on("pageerror", (e) => 问题.push(`[pageerror] ${e.message.slice(0, 200)}`));
  page.on("console", (m) => { if (m.type() === "error" && /hydrat/i.test(m.text())) 问题.push(`[hydration] ${m.text().slice(0, 200)}`); });
  await 登录(page);
  await 套预设(page, "外贸出口");

  await page.goto("/customers?new=1");
  const 框 = page.getByRole("dialog");
  await 框.getByLabel(/客户名称|客户姓名|姓名/).first().fill(新客户);
  await 框.getByLabel("WhatsApp").fill("+1 646 555 0199");
  await 框.getByLabel("国家").fill("美国");
  await 框.getByLabel("客户等级").click();
  await 选(page, "B 常规");
  await 框.getByLabel("销售负责人").click();
  await 选(page, "张三");
  await 框.getByLabel("官网").fill("acme-e2e");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框.getByText("官网格式不对")).toBeVisible();
  await 框.getByLabel("官网").fill("www.acme-e2e.com");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框).toBeHidden({ timeout: 15_000 });

  const db = 连库();
  const c = await db.customer.findFirstOrThrow({ where: { name: 新客户 }, include: { extra: true } });
  await db.$disconnect();
  expect(c.extra).toMatchObject({ level: "B", website: "www.acme-e2e.com", country: "美国" });

  await page.goto(`/customers/${c.id}`);
  const 标签行 = page.getByRole("main").locator(".rec-tags");
  await expect(标签行.locator(".cust-level")).toHaveText("B");
  await expect(标签行.getByRole("link", { name: /官网/ })).toHaveAttribute("href", "https://www.acme-e2e.com");
  // 浏览器钉在北京时间（playwright.config timezoneId），美国和北京差 12–13 小时，一定显示
  await expect(标签行.getByTestId("local-time")).toHaveText(/对方当地 (前一天 |次日 )?\d{2}:\d{2}/);

  // 档案里点「客户等级」那一格改成 A，标签行跟着变
  const 档案 = page.getByRole("main").locator(".rec-rail.rec-card");
  await 档案.locator(".rec-field", { hasText: "客户等级" }).click();
  await 选(page, "A 重点");
  await expect(标签行.locator(".cust-level")).toHaveText("A");
  expect(问题).toEqual([]);
});

test("界面：客户列表按等级筛、排；国家下面是对方此刻几点；官网收在「列」里", async ({ page }) => {
  await 登录(page);
  await page.goto(`/customers?keyword=${encodeURIComponent(前缀)}`);
  const 表 = page.locator(".ant-table").first();
  await expect(表.locator(".ant-table-thead").first()).toContainText("等级");
  await expect(表.locator(".ant-table-thead").first()).not.toContainText("官网");
  await expect(表.locator(".ant-table-row", { hasText: "甲A" }).locator(".country-cell")).toContainText(/美国\s*(前一天 |次日 )?\d{2}:\d{2}/);

  // 筛 A：只有甲A 和刚才改成 A 的那位
  await page.getByRole("combobox", { name: "客户等级" }).click();
  await 选(page, "A 重点");
  await expect(page).toHaveURL(/level=A/);
  await expect(表.locator(".ant-table-row")).toHaveCount(2);
  await expect(表).not.toContainText("乙C");

  // 未分级：只有丙空
  await page.getByRole("combobox", { name: "客户等级" }).click();
  await 选(page, "未分级");
  await expect(表.locator(".ant-table-row")).toHaveCount(1);
  await expect(表).toContainText("丙空");

  // 清掉筛选，点「等级」表头：A 在前，没分级的在最后
  await page.goto(`/customers?keyword=${encodeURIComponent(前缀)}`);
  await 表.locator(".ant-table-thead th", { hasText: "等级" }).click();
  await expect(page).toHaveURL(/sort=level-asc/);
  const 名字们 = await 表.locator(".ant-table-row a.link-strong").allInnerTexts();
  expect(名字们[名字们.length - 1]).toContain("丙空");
  expect(名字们.findIndex((x) => x.includes("乙C"))).toBeGreaterThan(名字们.findIndex((x) => x.includes("甲A")));
});

test("界面：外贸模版「记录跟进」的类型下拉里 WhatsApp 排第一", async ({ page }) => {
  await 登录(page);
  await page.goto(`/customers/${ids["丙空"]}`);
  await page.getByRole("button", { name: "记录跟进" }).click();
  const 框 = page.getByRole("dialog");
  await 框.getByLabel("跟进类型").click();
  await expect(page.locator(".ant-select-dropdown:visible .ant-select-item-option").first()).toHaveText("WhatsApp");
  await page.keyboard.press("Escape");
});

test("端到端：计划页点完成 → 小框记一笔（WhatsApp、7 天后）→ 计划完成、跟进记上、下一条排好", async ({ page }) => {
  await 登录(page);
  await page.goto("/follow-ups/plans");
  await page.getByRole("button", { name: "完成 发新报价" }).click();
  const 框 = page.getByTestId("complete-plan-modal");
  await expect(框).toBeVisible();
  await expect(框.locator(".done-plan-row", { hasText: "方式" }).first()).toContainText("WhatsApp");
  const 保存 = page.getByRole("button", { name: "保存并完成" });
  await expect(保存).toBeDisabled();
  await 框.getByLabel("这次聊了什么").fill("新报价发了，客户说周五回复");
  await expect(框).toContainText("会排一条");
  await 保存.click();
  await expect(page.getByText(/已记一笔，「发新报价」完成；下次/)).toBeVisible();
  await expect(page.getByRole("button", { name: "完成 发新报价" })).toHaveCount(0, { timeout: 5000 });

  const db = 连库();
  try {
    expect((await db.followPlan.findUniqueOrThrow({ where: { id: 计划.计划页 } })).done).toBe(true);
    const 跟 = await db.followUp.findFirstOrThrow({ where: { customerId: ids["甲A"] } });
    expect(跟).toMatchObject({ type: "WHATSAPP", status: "已完成", content: "新报价发了，客户说周五回复" });
    const 下 = await db.followPlan.findFirstOrThrow({ where: { customerId: ids["甲A"], done: false } });
    expect(下).toMatchObject({ subject: "接着跟进：新报价发了", method: "WhatsApp", plannedHasTime: false });
    const 天差 = Math.round((Date.parse(`${下.plannedOn}T00:00:00Z`) - Date.parse(`${new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })}T00:00:00Z`)) / 86400_000);
    expect(天差).toBe(7);
  } finally {
    await db.$disconnect();
  }

  // 记录页时间线：那条 WhatsApp 跟进在
  await page.goto(`/customers/${ids["甲A"]}`);
  await expect(page.getByRole("main")).toContainText("新报价发了，客户说周五回复");
  await expect(page.getByRole("main").locator(".rec-plan")).toContainText("接着跟进：新报价发了");
});

test("端到端：记录页「下次跟进」点完成 → 跳过，直接完成 → 和原来一样（提示带撤销），不记跟进", async ({ page }) => {
  await 登录(page);
  await page.goto(`/customers/${ids["乙C"]}`);
  await page.getByRole("main").locator(".rec-plan").getByRole("button", { name: /完\s*成/ }).click();
  const 框 = page.getByTestId("complete-plan-modal");
  await expect(框).toBeVisible();
  // 计划写的是老默认「电话沟通」，乙C 有 WhatsApp 号：默认 WhatsApp（2026-10-17 PR26 手测）
  await expect(框.locator(".done-plan-row", { hasText: "方式" }).first()).toContainText("WhatsApp");
  await page.getByRole("button", { name: "跳过，直接完成" }).click();
  await expect(page.getByText("「问样品反馈」已完成")).toBeVisible();
  await expect(page.getByRole("button", { name: "撤销" })).toBeVisible();
  const db = 连库();
  try {
    expect((await db.followPlan.findUniqueOrThrow({ where: { id: 计划.记录页 } })).done).toBe(true);
    expect(await db.followUp.count({ where: { customerId: ids["乙C"] } })).toBe(0);
  } finally {
    await db.$disconnect();
  }
});

test("端到端：记录页「保存并完成」后点提示里的「撤销」→ 刚记的那笔、刚排的下一条都没了，计划回到待办", async ({ page }) => {
  await 登录(page);
  const db = 连库();
  let 原计划: string;
  try {
    // 上面计划页那条排出来的「接着跟进：新报价发了」
    原计划 = (await db.followPlan.findFirstOrThrow({ where: { customerId: ids["甲A"], done: false } })).id;
  } finally {
    await db.$disconnect();
  }
  await page.goto(`/customers/${ids["甲A"]}`);
  await page.getByRole("main").locator(".rec-plan").getByRole("button", { name: /完\s*成/ }).click();
  const 框 = page.getByTestId("complete-plan-modal");
  await expect(框.locator(".done-plan-row", { hasText: "方式" }).first()).toContainText("WhatsApp");
  await 框.getByLabel("这次聊了什么").fill("点错了的一笔");
  await page.getByRole("button", { name: "保存并完成" }).click();
  await expect(page.getByText(/已记一笔，「接着跟进：新报价发了」完成；下次/)).toBeVisible();
  await page.getByRole("button", { name: "撤销" }).click();
  await expect(page.getByText("「接着跟进：新报价发了」已改回未完成，刚记的那笔已删掉")).toBeVisible();
  const db2 = 连库();
  try {
    expect((await db2.followPlan.findUniqueOrThrow({ where: { id: 原计划 } })).done).toBe(false);
    expect(await db2.followUp.count({ where: { customerId: ids["甲A"], content: "点错了的一笔" } })).toBe(0);
    expect(await db2.followPlan.count({ where: { customerId: ids["甲A"], subject: "接着跟进：点错了的一笔" } })).toBe(0);
  } finally {
    await db2.$disconnect();
  }
  await expect(page.getByRole("main").locator(".rec-plan")).toContainText("接着跟进：新报价发了");
});
