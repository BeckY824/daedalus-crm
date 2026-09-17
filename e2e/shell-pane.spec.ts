/**
 * 三栏壳的中栏（那 312px 的一列）。
 *
 * **2026-09-17 起中栏只剩一个地方：学员记录页的窄名单。**
 * 设计稿 03/LAYOUT 那条全站规则是「全局导航稳定，局部结构服从任务；
 * 中栏不是默认栏位，只有记录切换等明确场景才出现」。按这条撤掉的有三处：
 *   首页的「今天」   —— 待办进了信号行（逾期跟进 N · 先处理）
 *   商机的两个子页   —— 进了页头的「管道 / 列表」切换
 *   跟进的两个子页   —— 进了页头的「计划 / 记录」切换
 * 一个模块两个视图，不值得为它常驻一列 312px。
 *
 * 钉的是 2026-09-16 那个 bug：**从侧栏点进学员时中栏不出现，⌘R 刷新才出现。**
 * 原因是中栏的数据在 `(app)/layout.tsx` 里按 `x-pathname` 查，而 App Router 的 layout
 * **在客户端导航时不重新渲染**。现在中栏是并行路由槽位 `@pane/…`，它是 page，每次导航都重算。
 *
 * 所以这组用例**必须走客户端导航**（点侧栏链接、点表格里的行），不能用 page.goto ——
 * goto 是整页加载，layout 会重新跑，那样测什么都是绿的，正好漏掉这个 bug。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库, 清空业务数据, 造模拟数据 } from "./mock-data";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };

/**
 * 这一组自己造数据。**不能靠别的 spec 先跑过**：
 * 记录页的中栏要先有一位学员才点得进去，而单跑这个文件时库是空的
 * （第一版就是这样，整套绿、单跑全红）。
 */
test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await 造模拟数据(p);
  await p.$disconnect();
});

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

/**
 * 从学员列表点第一行进记录页，也是客户端导航。
 *
 * **先把窗口放到 1560。** 记录页的窄名单在 1440 以下会收成抽屉（那时 `aside.pane` 不存在，
 * 见 workbench 里「窄屏下名单收成抽屉」那条），而 playwright 的默认视口是 1280——
 * 不设宽度的话这一组验的其实是抽屉状态，全是假红。
 */
async function 进第一位学员(page: Page) {
  await page.setViewportSize({ width: 1560, height: 900 });
  await page.locator(".ant-table-tbody tr.ant-table-row").first().click();
  await expect(page).toHaveURL(/\/customers\/[^/]+$/);
}

const 到 = { 学员: /\/customers$/, 线索: /\/leads$/, 商机: /\/opportunities$/, 跟进: /\/follow-ups$/, 设置: /\/settings$/ };

test.describe("中栏跟着路由走", () => {
  test("首页没有中栏——一块工作画布", async ({ page }) => {
    await 登录(page);
    await expect(中栏(page)).toHaveCount(0);
  });

  test("六张列表页都没有中栏——全宽的一张表，旁边不挂同样内容的名单", async ({ page }) => {
    await 登录(page);
    for (const [名字, 落地] of [["学员", 到.学员], ["线索", 到.线索], ["商机", 到.商机], ["跟进", 到.跟进]] as const) {
      await 点侧栏(page, 名字, 落地);
      await expect(中栏(page)).toHaveCount(0);
    }
  });

  test("从列表点进学员记录页，中栏就该在——不用刷新", async ({ page }) => {
    await 登录(page);
    await 点侧栏(page, "学员", 到.学员);
    await 进第一位学员(page);
    // 就是这一条在修之前是红的：槽位是 page，客户端导航时会重算
    await expect(中栏(page)).toBeVisible();
    await expect(中栏(page).locator(".pane-t")).toContainText("学员");
  });

  test("刷新之后还在，且和点进来时是同一个中栏", async ({ page }) => {
    await 登录(page);
    await 点侧栏(page, "学员", 到.学员);
    await 进第一位学员(page);
    const 点进来的 = await 中栏(page).locator(".pane-t").innerText();
    await page.reload();
    await expect(中栏(page)).toBeVisible();
    expect(await 中栏(page).locator(".pane-t").innerText()).toBe(点进来的);
  });

  test("从记录页切走，中栏要跟着走干净——不能赖着上一页的", async ({ page }) => {
    await 登录(page);
    await 点侧栏(page, "学员", 到.学员);
    await 进第一位学员(page);
    await expect(中栏(page)).toBeVisible();
    await 点侧栏(page, "线索", 到.线索);
    await expect(中栏(page)).toHaveCount(0);
  });

  test("浏览器后退回到记录页，中栏要回来", async ({ page }) => {
    await 登录(page);
    await 点侧栏(page, "学员", 到.学员);
    await 进第一位学员(page);
    await expect(中栏(page)).toBeVisible();
    await 点侧栏(page, "线索", 到.线索);
    await expect(中栏(page)).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/customers\/[^/]+$/);
    await expect(中栏(page)).toBeVisible();
  });

  test("商机和跟进的两个视图改用页头按钮切换，不再占一列中栏", async ({ page }) => {
    await 登录(page);
    await 点侧栏(page, "商机", 到.商机);
    await page.getByRole("button", { name: "管道" }).click();
    await expect(page).toHaveURL(/\/opportunities\/pipeline$/);
    await expect(中栏(page)).toHaveCount(0);
    await page.getByRole("button", { name: "列表" }).click();
    await expect(page).toHaveURL(/\/opportunities$/);

    await 点侧栏(page, "跟进", 到.跟进);
    await page.getByRole("button", { name: "计划" }).click();
    await expect(page).toHaveURL(/\/follow-ups\/plans$/);
    await expect(中栏(page)).toHaveCount(0);
    await page.getByRole("button", { name: "记录" }).click();
    await expect(page).toHaveURL(/\/follow-ups$/);
  });

  test("设置从账号菜单进，弹的是一层浮层——不是另一页，也不摆两列目录", async ({ page }) => {
    await 登录(page);
    // 左栏 2026-09-17 起没有「设置」了：那一列是每天干活的地方，设置是偶尔去一趟的抽屉
    await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "设置" })).toHaveCount(0);

    await page.getByRole("button", { name: /账号菜单/ }).click();
    // 「个人资料」不在这个菜单里：它是设置里的第一栏，同一个地方不开两个门（2026-09-18）
    await expect(page.getByRole("menuitem").filter({ hasText: "个人资料" })).toHaveCount(0);
    /**
     * **点的是整行，不是那两个字。** 原来这条点的是 label 里的 <Link>，
     * 于是漏掉了 0.34.1 上报的那个 bug：真人点在图标上或右边那片空白上，
     * 菜单关掉、什么也没发生。这里故意点行的右端（⌘, 那一侧）。
     */
    const 设置行 = page.getByRole("menuitem").filter({ hasText: "设置" });
    /* 用 position 而不是自己算坐标：菜单是弹出来的，自己量会量在动画中间那一帧上，
       点出去就落到了遮罩上（第一版这么写，跑十次红一次）。
       x=120 在那两个字右边一大截，行本身 min-width 150 */
    await 设置行.click({ position: { x: 120, y: 12 } });

    // 地址变了（能分享、后退就是关闭），但底下那一页还在——它是一层，不是一次跳转
    await expect(page).toHaveURL(到.设置);
    await expect(page.locator(".setm-box")).toBeVisible();
    await expect(page.locator(".rail")).toBeVisible();
    await expect(中栏(page)).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "设置分类" })).toBeVisible();

    // Esc 关掉，回到原来那一页
    await page.keyboard.press("Escape");
    await expect(page.locator(".setm-box")).toHaveCount(0);
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("左栏能拖宽，宽度记得住；双击回默认", async ({ page }) => {
    await 登录(page);
    const 左栏 = page.locator("nav.rail");
    const 缝 = page.getByRole("separator", { name: /调整左栏宽度/ });
    const 原宽 = (await 左栏.boundingBox())!.width;

    const 缝框 = (await 缝.boundingBox())!;
    await page.mouse.move(缝框.x + 缝框.width / 2, 缝框.y + 200);
    await page.mouse.down();
    await page.mouse.move(缝框.x + 60, 缝框.y + 200, { steps: 8 });
    await page.mouse.up();
    const 拖后 = (await 左栏.boundingBox())!.width;
    expect(拖后).toBeGreaterThan(原宽 + 40);

    // 记得住：这是它和「拖一下就弹回去」的区别，也是唯一值得测的一条
    await page.reload();
    await expect(左栏).toHaveJSProperty("offsetWidth", Math.round(拖后));

    // 双击回默认——拖窄了之后总得有条退路，不用去设置里找
    await 缝.dblclick();
    expect((await 左栏.boundingBox())!.width).toBeCloseTo(原宽, 0);
  });

  test("自部署版的反馈键去 GitHub，不往我们这儿发", async ({ page }) => {
    /* 截住 window.open：真开一个新页会被 GitHub 跳到登录页，断言就成了在测 GitHub。
       这里要钉的只有一件事——点了以后去的是哪个地址 */
    await page.addInitScript(() => {
      (window as unknown as { 开过: string[] }).开过 = [];
      window.open = (u?: string | URL) => {
        (window as unknown as { 开过: string[] }).开过.push(String(u));
        return null;
      };
    });
    await 登录(page);
    // 这套 e2e 跑的是单租户（自部署）：他的实例不该认识我们的云，
    // 所以这里既不弹框也不发请求，点了直接开 issues
    const 键 = page.getByRole("button", { name: /反馈/ });
    await expect(键).toHaveAttribute("title", /GitHub/);

    let 发了请求 = false;
    page.on("request", (r) => {
      if (r.url().includes("/api/feedback")) 发了请求 = true;
    });
    await 键.click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    const 开过 = await page.evaluate(() => (window as unknown as { 开过: string[] }).开过);
    expect(开过[0]).toContain("github.com/BeckY824/daedalus-crm/issues");
    expect(发了请求).toBe(false);
  });

  test("直接敲 /settings 落到的是整页，不是浮层", async ({ page }) => {
    await 登录(page);
    await page.goto("/settings");
    await expect(page.locator(".setm-box")).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "设置分类" })).toBeVisible();
  });
});
