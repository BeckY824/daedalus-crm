/**
 * 三栏壳的中栏（那 312px 的一列）。
 *
 * **2026-09-17 起中栏只剩客户记录页的窄名单；2026-09-18 首页又长回来一条：问过的对话。**
 * 设计稿 03/LAYOUT 那条全站规则是「全局导航稳定，局部结构服从任务；
 * 中栏不是默认栏位，只有记录切换等明确场景才出现」。按这条撤掉的有三处：
 *   首页的「今天」   —— 待办进了信号行（逾期跟进 N · 先处理）
 *   商机的两个子页   —— 进了页头的「管道 / 列表」切换
 *   跟进的两个子页   —— 进了页头的「计划 / 记录」切换
 * 一个模块两个视图，不值得为它常驻一列 312px。
 *
 * 首页那条是按同一条规则加回来的：翻对话正是「在同类记录之间连着切」——
 * 而且它只在**配了 AI** 的库里出现，没配 AI 的首页是数据看板，根本没有对话这回事。
 *
 * 钉的是 2026-09-16 那个 bug：**从侧栏点进客户时中栏不出现，⌘R 刷新才出现。**
 * 原因是中栏的数据在 `(app)/layout.tsx` 里按 `x-pathname` 查，而 App Router 的 layout
 * **在客户端导航时不重新渲染**。现在中栏是并行路由槽位 `@pane/…`，它是 page，每次导航都重算。
 *
 * 所以这组用例**必须走客户端导航**（点侧栏链接、点表格里的行），不能用 page.goto ——
 * goto 是整页加载，layout 会重新跑，那样测什么都是绿的，正好漏掉这个 bug。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库, 清空业务数据, 造模拟数据 } from "./mock-data";
import { 装个假模型, 拆掉假模型 } from "./fake-llm";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };

/**
 * 这一组自己造数据。**不能靠别的 spec 先跑过**：
 * 记录页的中栏要先有一位客户才点得进去，而单跑这个文件时库是空的
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
 * 从客户列表点第一行进记录页，也是客户端导航。
 *
 * **先把窗口放到 1960。** 记录页的窄名单在 1214 以下（lib/roster 的 名单门槛）会收成抽屉（那时 `aside.pane` 不存在，
 * 见 workbench 里「窄屏下名单收成抽屉」那条），而 playwright 的默认视口是 1280——
 * 不设宽度的话这一组验的其实是抽屉状态，全是假红。
 * 右边的 AI 面板开着时它还要再让出 380（见 lib/roster.ts 的 DockOpenContext），
 * 而这套 e2e 里 AI 配没配要看别的 spec 留下了什么，所以按面板开着的情况给足宽度。
 */
async function 进第一位客户(page: Page) {
  await page.setViewportSize({ width: 1960, height: 900 });
  await page.locator(".ant-table-tbody tr.ant-table-row").first().click();
  await expect(page).toHaveURL(/\/customers\/[^/]+$/);
}

const 到 = { 客户: /\/customers$/, 线索: /\/leads$/, 商机: /\/opportunities$/, 跟进: /\/follow-ups$/, 设置: /\/settings$/ };

test.describe("中栏跟着路由走", () => {
  test("首页的中栏是「对话」——配了 AI 才有", async ({ page }) => {
    await 登录(page);
    /*
      这套 e2e 的 AI 配置由别的 spec 留下（workbench 那条存了一把指向 127.0.0.1:9 的 Key），
      所以两种情况都可能，一条用例把两种都认下来：
        配了 AI  → 中栏在，标题是「对话」
        没配 AI  → 首页是数据看板，没有中栏
      要分别钉住的话得在这儿动 Setting，那会把别的 spec 的前提也改了。
    */
    const 有中栏 = (await 中栏(page).count()) > 0;
    if (有中栏) await expect(中栏(page).locator(".pane-t")).toContainText("对话");
    else await expect(中栏(page)).toHaveCount(0);
  });

  test("六张列表页都没有中栏——全宽的一张表，旁边不挂同样内容的名单", async ({ page }) => {
    await 登录(page);
    for (const [名字, 落地] of [["客户", 到.客户], ["线索", 到.线索], ["商机", 到.商机], ["跟进", 到.跟进]] as const) {
      await 点侧栏(page, 名字, 落地);
      await expect(中栏(page)).toHaveCount(0);
    }
  });

  test("从列表点进客户记录页，中栏就该在——不用刷新", async ({ page }) => {
    await 登录(page);
    await 点侧栏(page, "客户", 到.客户);
    await 进第一位客户(page);
    // 就是这一条在修之前是红的：槽位是 page，客户端导航时会重算
    await expect(中栏(page)).toBeVisible();
    await expect(中栏(page).locator(".pane-t")).toContainText("客户");
  });

  test("默认窗口 1440、右边面板开着：记录页的时间线不能被挤成一条缝", async ({ page }) => {
    // 2026-09-25 录教程时撞到：面板开着时视口断点以为还有 1440，名单和 AI 栏照摆，时间线只剩 30 来宽、字竖着排
    await 登录(page);
    await 点侧栏(page, "客户", 到.客户);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator(".ant-table-tbody tr.ant-table-row").first().click();
    await expect(page).toHaveURL(/\/customers\/[^/]+$/);
    const 时间线 = page.locator(".rec > .rec-col").first();
    await expect(时间线).toBeVisible();
    await expect.poll(async () => (await 时间线.boundingBox())?.width ?? 0).toBeGreaterThan(300);
  });

  test("刷新之后还在，且和点进来时是同一个中栏", async ({ page }) => {
    await 登录(page);
    await 点侧栏(page, "客户", 到.客户);
    await 进第一位客户(page);
    const 点进来的 = await 中栏(page).locator(".pane-t").innerText();
    await page.reload();
    await expect(中栏(page)).toBeVisible();
    expect(await 中栏(page).locator(".pane-t").innerText()).toBe(点进来的);
  });

  test("从记录页切走，中栏要跟着走干净——不能赖着上一页的", async ({ page }) => {
    await 登录(page);
    await 点侧栏(page, "客户", 到.客户);
    await 进第一位客户(page);
    await expect(中栏(page)).toBeVisible();
    await 点侧栏(page, "线索", 到.线索);
    await expect(中栏(page)).toHaveCount(0);
  });

  test("浏览器后退回到记录页，中栏要回来", async ({ page }) => {
    await 登录(page);
    await 点侧栏(page, "客户", 到.客户);
    await 进第一位客户(page);
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

    /* 冷启动编译时页面可能还没水合，第一下点了没反应（整套连跑时偶发，单跑都过）：
       没弹出来就再点，直到菜单真的出现 */
    await expect(async () => {
      if (!(await page.getByRole("menuitem").filter({ hasText: "设置" }).isVisible())) await page.getByRole("button", { name: /账号菜单/ }).click();
      await expect(page.getByRole("menuitem").filter({ hasText: "设置" })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
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
    /*
      先等左栏宽度落定再量。整套连跑时偶尔在样式还没到位的那一刻就量了：
      量到 1264（整个窗口宽），拖完 277，断言「比原来宽 40」自然不成立（2026-09-28 撞过一次，单独重跑 5 遍全过）。
      左栏默认两百来宽，半个窗口是个足够松的上限。
    */
    await expect(缝).toBeVisible();
    // 看得见不等于拖得动：缝是服务端画的，要等 React 接上事件（WidthHandle 挂载后打 data-ready）
    await expect(缝).toHaveAttribute("data-ready", "");
    await expect.poll(async () => (await 左栏.boundingBox())?.width ?? Infinity).toBeLessThan(600);
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
    await expect(缝).toHaveAttribute("data-ready", "");
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
    // 同上：还没水合时第一下点了没反应，点到真的开了为止（开过一次就不再点）
    await expect(async () => {
      if (!(await page.evaluate(() => (window as unknown as { 开过: string[] }).开过.length))) await 键.click();
      expect(await page.evaluate(() => (window as unknown as { 开过: string[] }).开过.length)).toBeGreaterThan(0);
    }).toPass({ timeout: 30_000 });

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

/*
  桌面端（UA 带 Electron/）的「客户」：照毛玻璃原型直接进「名单 + 详情」，打开最近看过的那位（2026-10-03）。
  网页版照旧进表格——上面那组钉着。
*/
test.describe("桌面端：左栏「客户」直接进名单 + 详情", () => {
  test.use({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) DaedalusCRM/0.46.15 Chrome/138.0.0.0 Electron/38.8.6 Safari/537.36" });

  test("点「客户」进某位的详情、中栏名单在；换一位再回首页，点「客户」回到刚才那位", async ({ page }) => {
    await 登录(page);
    await page.setViewportSize({ width: 1960, height: 900 });
    await 点侧栏(page, "客户", /\/customers\/[^/]+$/);
    await expect(中栏(page)).toBeVisible();
    // 在名单里换第二位
    const 第二位 = 中栏(page).locator(".roster-row").nth(1);
    const 去处 = await 第二位.getAttribute("href");
    await 第二位.click();
    await expect(page).toHaveURL(new RegExp(`${去处}$`));
    await 点侧栏(page, "首页", /\/dashboard$/);
    await 点侧栏(page, "客户", new RegExp(`${去处}$`));
    // 表格还在名单右上角
    await 中栏(page).getByRole("link", { name: /表格/ }).first().click();
    await expect(page).toHaveURL(/\/customers$/);
  });
});

/*
  2026-10-04 回归核对 J-201 / J-186：设置浮层的两处修了没钉。
    J-201 从首页开设置，背后冒出 AI 面板（首页本来不出现它）；不带 ?tab= 时左边哪一项都不亮、正文却是个人资料
    J-186 切设置页签整页向服务端重要一遍（200 条日志、成员、云端余额），切一下卡半秒
  面板只在配了 AI 时才有，所以这一组自己装个假模型、跑完拆掉
*/
test.describe("设置浮层：背后不冒面板、高亮和正文对得上、切页签不重拉", () => {
  test.use({ viewport: { width: 1680, height: 1000 } });
  test.beforeAll(async ({ browser }) => 装个假模型(browser));
  test.afterAll(async ({ browser }) => 拆掉假模型(browser));

  async function 从账号菜单开设置(page: Page) {
    await expect(async () => {
      if (!(await page.getByRole("menuitem").filter({ hasText: "设置" }).isVisible())) await page.getByRole("button", { name: /账号菜单/ }).click();
      await expect(page.getByRole("menuitem").filter({ hasText: "设置" })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await page.getByRole("menuitem").filter({ hasText: "设置" }).click({ position: { x: 120, y: 12 } });
    await expect(page.locator(".setm-box")).toBeVisible();
  }

  test("J-201：从首页开设置，背后不冒出 AI 面板；左边亮的那一项就是右边摆的那一栏", async ({ page }) => {
    await 登录(page);
    await expect(page).toHaveURL(/\/dashboard/);
    // 窗口够宽、配了 AI：首页本身就不画面板（它就是宽模式的同一块）
    await expect(page.locator("aside.dock")).toHaveCount(0);
    await 从账号菜单开设置(page);
    await expect(page).toHaveURL(/\/settings$/);
    await page.waitForTimeout(500);
    await expect(page.locator("aside.dock")).toHaveCount(0);

    // 左边亮且只亮一项，正文就是它那一栏（默认栏不摆出来的情形——桌面端没有「团队成员」——在 e2e-desktop/07 里钉）
    const 亮的 = page.locator('.setm-box [role="tab"][aria-selected="true"]');
    await expect(亮的).toHaveCount(1);
    const 亮的id = await 亮的.getAttribute("id");
    await expect(page.locator(".setm-box [role=\"tabpanel\"]")).toHaveAttribute("aria-labelledby", 亮的id!);

    await page.keyboard.press("Escape");
    await expect(page.locator(".setm-box")).toHaveCount(0);
    await expect(page.locator("aside.dock")).toHaveCount(0);
  });

  test("J-186：设置里切页签只改地址栏，不再向服务端把整页重要一遍", async ({ page }) => {
    await 登录(page);
    await page.goto("/settings");
    const 页签 = page.getByRole("tablist", { name: "设置分类" }).getByRole("tab");
    await expect(页签.first()).toBeVisible();
    await page.waitForLoadState("networkidle").catch(() => {});
    const 重拉: string[] = [];
    page.on("request", (r) => {
      const u = r.url();
      if (r.resourceType() === "document" || /[?&]_rsc=/.test(u) || r.headers()["rsc"] === "1") 重拉.push(`${r.method()} ${u}`);
    });
    const n = Math.min(await 页签.count(), 3);
    for (let i = 0; i < n; i++) {
      await 页签.nth(i).click();
      await expect(页签.nth(i)).toHaveAttribute("aria-selected", "true");
      await expect(page).toHaveURL(/\?tab=/);
    }
    await page.waitForTimeout(800);
    expect(重拉, "切页签时向服务端重要了整页").toEqual([]);
  });
});
