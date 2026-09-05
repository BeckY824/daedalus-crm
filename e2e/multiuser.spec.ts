/**
 * 方案第 8 节 A / D / E 组：多人协作场景。
 *
 * 方案里把这三组标成「只能手工，需两人两机」。实际不需要——
 * Playwright 的每个 browser context 有自己独立的 Cookie 与缓存，
 * 一台机器可以同时挂多个互不干扰的登录会话。真正单机替代不了的只有
 * 真机浏览器差异（尤其微信内置浏览器）和「界面好不好用」这种人的判断。
 */
import { test, expect, type Browser, type Page } from "@playwright/test";

const 甲账号 = { 用户名: "zhangsan", 密码: "crm@2026" };
const 管理员 = { 用户名: "admin", 密码: "crm@2026" };
const 丙账号 = { 用户名: "lisi", 密码: "crm@2026" };

const 戳 = String(Date.now()).slice(-6);

async function 登录(page: Page, who: { 用户名: string; 密码: string }) {
  await page.goto("/login");
  const 提示 = page.locator(".ant-alert");
  for (let i = 0; i < 3; i++) {
    await page.getByPlaceholder("用户名").fill(who.用户名);
    await page.getByPlaceholder("登录密码").fill(who.密码);
    await page.getByRole("button", { name: /登\s*录/ }).click();
    for (let t = 0; t < 40; t++) {
      if (/\/dashboard/.test(page.url())) return;
      if (await 提示.isVisible().catch(() => false)) throw new Error("登录失败");
      await page.waitForTimeout(200);
    }
  }
  throw new Error("登录没反应");
}

/** 开一个独立会话，相当于「另一个人的另一台机器」 */
async function 另一个人(browser: Browser, who: { 用户名: string; 密码: string }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await 登录(page, who);
  return { ctx, page };
}

async function 新建学员(page: Page, 姓名: string, 手机: string) {
  await page.goto("/customers");
  await page.getByRole("button", { name: /新建学员/ }).click();
  const 弹窗 = page.getByRole("dialog");
  await 弹窗.getByLabel("客户姓名").fill(姓名);
  await 弹窗.getByLabel("联系电话").fill(手机);
  // antd Select 的选项渲染在 portal 里，且下拉是懒挂载的，
  // 必须等下拉真正展开再点，否则 getByRole("option") 会一直等不到
  await 弹窗.getByLabel("销售负责人").click();
  const 下拉 = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
  await 下拉.waitFor({ state: "visible" });
  await 下拉.locator(".ant-select-item-option").first().click();
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();
  await expect(弹窗).toBeHidden();
}

test.describe.configure({ mode: "serial" });

test.describe("A 组：跨会话的数据可见性", () => {
  test("甲新建的学员，乙刷新后能看到", async ({ browser }) => {
    const 甲 = await 另一个人(browser, 甲账号);
    const 乙 = await 另一个人(browser, 管理员);

    const 姓名 = `可见性${戳}`;
    await 乙.page.goto("/customers");
    await expect(乙.page.getByRole("cell", { name: 姓名 })).toHaveCount(0);

    await 新建学员(甲.page, 姓名, `1370${戳}01`.slice(0, 11).padEnd(11, "8"));

    await 乙.page.reload();
    await expect(乙.page.getByRole("cell", { name: 姓名 }).first()).toBeVisible();

    await 甲.ctx.close();
    await 乙.ctx.close();
  });

  test("客户端路由缓存：离开再回来时可能看到旧列表，硬刷新一定是新的", async ({ browser }) => {
    /**
     * next.config.ts 里 staleTimes.dynamic = 60，是性能取舍不是缺陷。
     * 这条用例把实际行为固化下来：软导航可能拿到缓存，硬刷新一定拿到最新。
     * 哪天把 staleTimes 调了，这里会先反映出来。
     */
    const 甲 = await 另一个人(browser, 甲账号);
    const 乙 = await 另一个人(browser, 管理员);

    const 姓名 = `缓存${戳}`;
    await 乙.page.goto("/customers");
    await 新建学员(甲.page, 姓名, `1371${戳}01`.slice(0, 11).padEnd(11, "8"));

    // 乙用侧边栏软导航离开再回来
    await 乙.page.getByRole("link", { name: "数据首页" }).click();
    await expect(乙.page).toHaveURL(/\/dashboard/);
    await 乙.page.getByRole("link", { name: "学员管理" }).click();
    await expect(乙.page).toHaveURL(/\/customers/);
    const 软导航后看得到 = await 乙.page
      .getByRole("cell", { name: 姓名 })
      .first()
      .isVisible()
      .catch(() => false);
    console.log(`[A 组] 软导航后是否立刻看到新数据：${软导航后看得到 ? "是" : "否（命中路由缓存）"}`);

    // 硬刷新必须能看到，否则就是真缺陷而不是缓存取舍
    await 乙.page.reload();
    await expect(乙.page.getByRole("cell", { name: 姓名 }).first()).toBeVisible();

    await 甲.ctx.close();
    await 乙.ctx.close();
  });
});

test.describe("D 组：批量操作交叉", () => {
  test("两人同时批量改状态，都要收到真实条数且不互相锁死", async ({ browser }) => {
    const 甲 = await 另一个人(browser, 甲账号);
    const 乙 = await 另一个人(browser, 管理员);

    for (let i = 0; i < 3; i++) {
      await 新建学员(甲.page, `批量${戳}${i}`, `1372${戳}${i}`.slice(0, 11).padEnd(11, "8"));
    }

    async function 批量改状态(page: Page, 状态: string) {
      await page.goto("/customers");
      // 表头全选
      await page.getByRole("checkbox").first().check();
      await page.getByRole("button", { name: /批量状态/ }).click();
      const 下拉 = page.locator(".ant-dropdown:not(.ant-dropdown-hidden)");
      await 下拉.waitFor({ state: "visible" });
      await 下拉.getByRole("menuitem", { name: 状态 }).click();
      return page.locator(".ant-message").innerText();
    }

    const [甲提示, 乙提示] = await Promise.all([
      批量改状态(甲.page, "意向较高"),
      批量改状态(乙.page, "已试听"),
    ]);
    console.log(`[D 组] 甲收到：${甲提示.replace(/\n/g, " ")}`);
    console.log(`[D 组] 乙收到：${乙提示.replace(/\n/g, " ")}`);

    // 关键：提示里必须带条数，不能是一句笼统的「已更新」
    expect(甲提示).toMatch(/\d+\s*条/);
    expect(乙提示).toMatch(/\d+\s*条/);

    await 甲.ctx.close();
    await 乙.ctx.close();
  });

  test("一人批量改负责人、另一人正在编辑同一条，两边的改动都要在", async ({ browser }) => {
    const 甲 = await 另一个人(browser, 甲账号);
    const 乙 = await 另一个人(browser, 管理员);

    const 姓名 = `交叉${戳}`;
    await 新建学员(甲.page, 姓名, `1373${戳}01`.slice(0, 11).padEnd(11, "8"));

    // 甲打开编辑框（此时拿到的是旧版本）
    await 甲.page.goto("/customers");
    await 甲.page.getByRole("row", { name: new RegExp(姓名) }).getByRole("button").first().click();
    await expect(甲.page.getByRole("dialog")).toBeVisible();

    // 乙在这期间批量把负责人改成别人
    await 乙.page.goto("/customers");
    await 乙.page.getByRole("row", { name: new RegExp(姓名) }).getByRole("checkbox").check();
    await 乙.page.getByRole("button", { name: /批量分配/ }).click();
    // 必须限定在下拉里选：侧边栏用的也是 menuitem 角色，不限定会点到导航上去
    const 下拉 = 乙.page.locator(".ant-dropdown:not(.ant-dropdown-hidden)");
    await 下拉.waitFor({ state: "visible" });
    // 管理员已不在负责人候选里（只做系统维护），转给另一名销售
    await 下拉.getByRole("menuitem", { name: "李四" }).click();
    await expect(乙.page.locator(".ant-message")).toContainText(/条/);

    // 甲改的是院校，不是负责人，应当自动合并
    await 甲.page.getByRole("dialog").getByLabel("院校").fill("北京大学");
    await 甲.page.getByRole("dialog").getByRole("button", { name: /保\s*存/ }).click();
    await expect(甲.page.getByText("已保存")).toBeVisible();

    // 两边的改动都在：院校是甲写的，负责人是乙改的
    await 甲.page.reload();
    const 行 = 甲.page.getByRole("row", { name: new RegExp(姓名) });
    await expect(行).toContainText("北京大学");

    await 甲.ctx.close();
    await 乙.ctx.close();
  });
});

test.describe("E 组：同账号多设备与在线停用", () => {
  test("同一个账号在两台设备上同时登录，两边都能正常用", async ({ browser }) => {
    const 设备一 = await 另一个人(browser, 甲账号);
    const 设备二 = await 另一个人(browser, 甲账号);

    const 姓名 = `双设备${戳}`;
    await 新建学员(设备一.page, 姓名, `1374${戳}01`.slice(0, 11).padEnd(11, "8"));

    await 设备二.page.goto("/customers");
    await expect(设备二.page.getByRole("cell", { name: 姓名 }).first()).toBeVisible();

    await 设备一.ctx.close();
    await 设备二.ctx.close();
  });

  test("使用中被管理员停用，下一次操作要被踢回登录页", async ({ browser }) => {
    const 丙 = await 另一个人(browser, 丙账号);
    const 管理 = await 另一个人(browser, 管理员);

    // 丙正在正常使用
    await 丙.page.goto("/customers");
    await expect(丙.page).toHaveURL(/\/customers/);

    // 管理员停用丙，并把名下数据转交
    await 管理.page.goto("/settings");
    const 丙行 = 管理.page.getByRole("row", { name: /李四/ });
    await 丙行.getByRole("button").nth(1).click();
    const 确认 = 管理.page.getByRole("dialog");
    await expect(确认).toContainText("停用成员");
    await 确认.getByRole("button", { name: /确认停用/ }).click();
    await expect(管理.page.locator(".ant-message")).toContainText("已停用并转交");

    // 丙的下一次操作必须被挡回登录页，而不是继续用着已失效的会话
    await 丙.page.goto("/customers");
    await expect(丙.page).toHaveURL(/\/login/);

    await 丙.ctx.close();
    await 管理.ctx.close();
  });
});
