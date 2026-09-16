/**
 * 三栏壳的中栏（那 312px 的一列）。
 *
 * **2026-09-17（批 2）起学员列表页没有中栏了**：列表已经是一张全宽的表，
 * 旁边再挂一条同样内容的名单是把同一件事画两遍。那条「最近跟进的 50 位」
 * 挪去了记录页左边（220px 的窄名单），因为缺「换一个人」这条路的是记录页。
 * 所以下面学员那几条验的是：列表页没有、记录页有。
 *
 * 钉的是 2026-09-16 那个 bug：**从侧栏点进学员管理时中栏不出现，⌘R 刷新才出现。**
 * 原因是中栏的数据在 `(app)/layout.tsx` 里按 `x-pathname` 查，而 App Router 的 layout
 * **在客户端导航时不重新渲染**——从首页点过去时 layout 还是首页那次的结果。
 * 商机 / 跟进 / 设置的中栏是静态列表，不依赖那次查询，所以只有学员页露馅，
 * 表现成「一会儿三栏一会儿两栏」。现在中栏改成并行路由槽位 `@pane/[...slug]`，它是 page。
 *
 * 所以这组用例**必须走客户端导航**（点侧栏链接），不能用 page.goto ——
 * goto 是整页加载，layout 会重新跑，那样测什么都是绿的，正好漏掉这个 bug。
 */
import { test, expect, type Page } from "@playwright/test";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };

async function 登录(page: Page) {
  await page.goto("/login");
  const 提示 = page.locator(".ant-alert");
  for (let i = 0; i < 3; i++) {
    await page.getByPlaceholder("用户名").fill(账号.用户名);
    await page.getByPlaceholder("登录密码").fill(账号.密码);
    await page.getByRole("button", { name: /登\s*录/ }).click();
    for (let t = 0; t < 40; t++) {
      if (/\/dashboard/.test(page.url())) return;
      if (await 提示.isVisible().catch(() => false)) throw new Error("登录失败");
      await page.waitForTimeout(200);
    }
  }
  throw new Error("登录没反应");
}

const 中栏 = (page: Page) => page.locator("aside.pane");
/**
 * 点图标栏里的入口，走客户端导航——这是本组用例的全部意义。
 * 点完等 URL 真的到位再返回：客户端导航是异步的，不等就可能在上一页上做断言
 * （写这组时 goBack 那条就是这么假红的）。
 */
async function 点侧栏(page: Page, 名字: string | RegExp, 落地: RegExp) {
  await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: 名字 }).click();
  await expect(page).toHaveURL(落地);
}

const 到 = { 学员: /\/customers$/, 线索: /\/leads$/, 商机: /\/opportunities$/, 跟进: /\/follow-ups$/, 设置: /\/settings$/ };

test.describe("中栏跟着路由走", () => {
  test("学员列表页没有中栏——全宽的一张表，旁边不挂同样内容的名单", async ({ page }) => {
    await 登录(page);
    await expect(中栏(page)).toBeVisible(); // 首页的「今天」
    await 点侧栏(page, "学员管理", 到.学员);
    await expect(中栏(page)).toHaveCount(0);
  });

  test("从首页点侧栏进商机，中栏就该在——不用刷新", async ({ page }) => {
    await 登录(page);
    await expect(中栏(page)).toBeVisible();
    await 点侧栏(page, "商机管理", 到.商机);
    // 就是这一条在修之前是红的（那时露馅的是学员，现在学员列表页没有中栏了，
    // 换任何一个有中栏的模块都能验同一件事：槽位是 page，客户端导航时会重算）
    await expect(中栏(page)).toBeVisible();
    await expect(中栏(page).locator(".pane-t")).toContainText("商机");
  });

  test("刷新之后还在，且和点进来时是同一个中栏", async ({ page }) => {
    await 登录(page);
    await 点侧栏(page, "跟进管理", 到.跟进);
    const 点进来的 = await 中栏(page).locator(".pane-t").innerText();
    await page.reload();
    await expect(中栏(page)).toBeVisible();
    expect(await 中栏(page).locator(".pane-t").innerText()).toBe(点进来的);
  });

  test("没有中栏的模块一个节点都不留，不能空着一列", async ({ page }) => {
    await 登录(page);
    await 点侧栏(page, "线索管理", 到.线索);
    await expect(中栏(page)).toHaveCount(0);
  });

  test("来回切也不会掉：商机 → 线索 → 商机", async ({ page }) => {
    await 登录(page);
    await 点侧栏(page, "商机管理", 到.商机);
    await expect(中栏(page)).toBeVisible();
    await 点侧栏(page, "线索管理", 到.线索);
    await expect(中栏(page)).toHaveCount(0);
    await 点侧栏(page, "商机管理", 到.商机);
    await expect(中栏(page)).toBeVisible();
  });

  test("浏览器后退回到有中栏的页，中栏要回来", async ({ page }) => {
    await 登录(page);
    await 点侧栏(page, "商机管理", 到.商机);
    await expect(中栏(page)).toBeVisible();
    await 点侧栏(page, "线索管理", 到.线索);
    await expect(中栏(page)).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/opportunities$/);
    await expect(中栏(page)).toBeVisible();
  });

  test("商机 / 跟进 的中栏照旧，且各是各的标题", async ({ page }) => {
    await 登录(page);
    // 设置页 2026-09-17（批 4）起自己带左目录，中栏就撤了——
    // 一页上摆两列目录，人得先弄清它们有什么区别
    for (const [名字, 标题, 落地] of [["商机管理", "商机", 到.商机], ["跟进管理", "跟进", 到.跟进]] as const) {
      await 点侧栏(page, 名字, 落地);
      await expect(中栏(page)).toBeVisible();
      await expect(中栏(page).locator(".pane-t")).toHaveText(标题);
    }
  });
});
