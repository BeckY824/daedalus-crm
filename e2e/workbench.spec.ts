/**
 * 批 2「三张母版」和批 3「列表扩展」的验收。
 *
 * 首页只有配了 AI 才是对话面（没配就直接是数据看板），而默认 e2e 是不配的——
 * 配了每条用例都会真的去打模型，慢、花钱、结果还随模型抖动。
 * 所以这一组自己在「设置 → AI 接入」里填一把假 Key 把对话面打开，跑完删掉。
 * 打开的只是**界面**：真去调用会连不上那个假地址，而这组一次模型都不调。
 *
 * 为什么要走界面而不是直接往库里写一行：设置读取有进程内缓存，只有走
 * `setSetting` 的那条路才会让它失效（见 lib/settings.ts 的注释）。
 * 绕过去写进去的那一行，长期跑着的 dev server 根本读不到——
 * 这条用例第一次写完单独跑是绿的、进了整套就挂，就是这么回事。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库, 清空业务数据, 造模拟数据 } from "./mock-data";
// AI 接入那几步只留一份：ai-dock 和 import 两组也要装同一个假模型
import { 配好AI } from "./fake-llm";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };
/** 只有管理员能改 AI 接入 */
const 管理员 = { 用户名: "admin", 密码: "admin123" };

async function 登录(page: Page, who = 账号) {
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

test.describe.configure({ mode: "serial", timeout: 90_000 });

test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await p.$disconnect();
});

test("先把 AI 接入填上——首页是对话面还是数据看板，就看这一项", async ({ page }) => {
  await 登录(page, 管理员);
  await 配好AI(page);
});

test.afterAll(async () => {
  // 库里收拾干净就行。dev server 那边的设置缓存不用管：每轮 e2e 都是新库新进程
  const p = 连库();
  await p.setting.deleteMany({ where: { key: "llm" } });
  await 清空业务数据(p);
  await p.$disconnect();
});

/**
 * MCP 那个口子（2026-09-18）。**这是唯一一条别人能从外面连进来的路**，
 * 所以先钉住它关着：没令牌一律 401，GET 不给挂流。
 * 令牌真能用那一条在单测里（tests/mcp.test.ts），那边不用起浏览器。
 */
test("MCP 端点：没令牌进不来", async ({ request, baseURL }) => {
  const 无票 = await request.post(`${baseURL}/api/mcp`, {
    data: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  });
  expect(无票.status()).toBe(401);
  expect(await 无票.text()).toContain("令牌");

  const 乱票 = await request.post(`${baseURL}/api/mcp`, {
    // 纯 ASCII：中文塞进 Authorization 头会在 fetch 那一层就报错，测不到服务端
    headers: { Authorization: "Bearer dcrm_guessed_wrong" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  expect(乱票.status()).toBe(401);

  // 客户端会开一条 GET 收服务端主动发的消息；我们没有要说的话，明确回 405 让它别等
  expect((await request.get(`${baseURL}/api/mcp`)).status()).toBe(405);
});

/**
 * 问过的对话（2026-09-18）。
 *
 * 在这之前首页那串问答只活在内存里，刷新即清，也开不出第二个——
 * 「上周问的那条回款是怎么算的」没有任何地方翻得到。
 *
 * 这条不调模型：真去问一句要等模型，而且这套 e2e 的地址是假的。
 * 直接往库里放一条答完的对话，验的是**读回来这条路**——列表、点开、清屏。
 */
test("对话历史：中栏列着问过的，点一条能把它读回来", async ({ page }) => {
  const p = 连库();
  const me = await p.user.findFirstOrThrow({ where: { email: "admin" } });
  await p.aiConversation.deleteMany({ where: { ownerId: me.id } });
  const c = await p.aiConversation.create({ data: { title: "这个月谁签得最多", ownerId: me.id } });
  await p.aiMessage.create({ data: { conversationId: c.id, role: "user", text: "这个月谁签得最多" } });
  await p.aiMessage.create({
    data: { conversationId: c.id, role: "assistant", text: "这个月张三签得最多，合计 ¥32,600。", model: "e2e-model", ms: 4200 },
  });
  await p.$disconnect();

  await 登录(page, 管理员);
  await 配好AI(page); // 单跑这一条时前面那条不会执行，对话面得自己打开
  await page.goto("/dashboard");

  // 中栏在，标题是「对话」，里面有那一条
  const 中栏 = page.locator("aside.pane");
  await expect(中栏.locator(".pane-t")).toContainText("对话");
  // exact：那一行旁边还有一颗「… 的操作」，不加会同时命中两个
  await 中栏.getByRole("button", { name: "这个月谁签得最多", exact: true }).click();

  // 地址跟着走，问和答都读回来了
  await expect(page).toHaveURL(new RegExp(`\\?c=${c.id}`));
  await expect(page.locator(".cli-bubble")).toContainText("这个月谁签得最多");
  await expect(page.locator(".cli-a")).toContainText("32,600");

  // 「新建对话」把这一屏清空，回到问候屏；库里那条不受影响
  await 中栏.getByRole("button", { name: "新建对话" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator(".cli-turn")).toHaveCount(0);
  await expect(中栏.getByRole("button", { name: "这个月谁签得最多", exact: true })).toBeVisible();
});

test("空库首页：一张「开始」卡，整页只有一个主按钮，没有指标卡", async ({ page }) => {
  await 登录(page);
  await page.goto("/dashboard");
  await page.waitForSelector(".start");

  // 三步说清它替你做什么
  await expect(page.locator(".start-steps li")).toHaveCount(3);
  // 「每页一个主动作」：空库时整个正文里只能有一个主按钮
  await expect(page.locator("main .ant-btn-primary")).toHaveCount(1);
  // 空库不画任何指标：四个 0 比没有更糟
  await expect(page.locator("main .stat-card")).toHaveCount(0);
  await expect(page.locator("main .signals")).toHaveCount(0);
});

test("有数据的首页：一行三个信号，不是三张卡", async ({ page }) => {
  const p = 连库();
  await 造模拟数据(p);
  await p.$disconnect();

  await 登录(page);
  await page.goto("/dashboard");
  await page.waitForSelector(".signals");

  await expect(page.locator(".signals .signal")).toHaveCount(3);
  // 指标卡一张都不能有——原来的方案是三张 KPI 卡叠三张「可以直接开始」卡
  await expect(page.locator("main .stat-card")).toHaveCount(0);
  // 每个信号都要能点进一个能把这个数重新数一遍的页面，且都带口径
  for (const 信号 of await page.locator(".signals .signal").all()) {
    expect(await 信号.getAttribute("href")).toBeTruthy();
    expect((await 信号.getAttribute("title")) ?? "").not.toBe("");
  }
});

test("首页：⌘K 把光标放回输入框", async ({ page }) => {
  await 登录(page);
  await page.goto("/dashboard");
  await page.waitForSelector(".cli-input textarea");
  await page.locator("body").click();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".cli-input textarea")).toBeFocused();
});

test("客户列表：空库时不摆筛选栏，主动作还在原位", async ({ page }) => {
  const p = 连库();
  await 清空业务数据(p);
  await p.$disconnect();

  await 登录(page);
  await page.goto("/customers");
  await page.waitForSelector(".list");
  await expect(page.getByPlaceholder("姓名 / 电话 / 公司 / 行业")).toHaveCount(0);
  // 「新建」任何时候都在：空状态里那个是引导，不是它的替代品
  await expect(page.getByRole("button", { name: /新建客户/ })).toBeVisible();
});

test("客户列表：默认只摆六列，其余在「列」里", async ({ page }) => {
  const p = 连库();
  await 造模拟数据(p);
  await p.$disconnect();

  await 登录(page);
  await page.goto("/customers");
  await page.waitForSelector(".ant-table-row");

  // 六列 + 勾选框 + 操作列
  const 表头 = await page.locator(".ant-table-thead th").allInnerTexts();
  expect(表头.filter((t) => t.trim()).length).toBe(6);

  // 收起来的列要能勾出来
  await page.getByRole("button", { name: "列" }).click();
  const 菜单 = page.locator(".ant-dropdown:not(.ant-dropdown-hidden)");
  await 菜单.waitFor({ state: "visible" });
  await 菜单.getByText("联系电话").click();
  await expect(page.locator(".ant-table-thead th", { hasText: "联系电话" })).toBeVisible();
});

/*
  勾一项不该把单子收掉。选列天然是连着点好几下的事——点一下关一次，
  每改一列都要重新打开一次，改三列就是开三次。
  antd 的菜单项默认点完就收，所以这个 Dropdown 是受控的（DataList.tsx）：
  来源是 menu 的关闭一概不理，只认再点一次按钮和点到外面。
  这条用例钉的就是那个「不理」——它坏了不会报错，只会退回每点一次关一次。
*/
test("列设置：能连着勾好几项，单子不会自己收；再点按钮才收", async ({ page }) => {
  const p = 连库();
  // 这个文件串行共库，上一条已经造过同名渠道——不先清就是唯一键撞车。
  // 单独跑能过、进整套就挂，正是这么回事
  await 清空业务数据(p);
  await 造模拟数据(p);
  await p.$disconnect();

  await 登录(page);
  await page.goto("/customers");
  await page.waitForSelector(".ant-table-row");

  const 列按钮 = page.getByRole("button", { name: "列" });
  const 菜单 = page.locator(".ant-dropdown:not(.ant-dropdown-hidden)");

  await 列按钮.click();
  await 菜单.waitFor({ state: "visible" });

  // 连着勾两项，每勾一次单子都还得在。
  // 挑这两个是因为它们的名字不跟业务配置走（「职位/年级」那一列会跟着变）
  for (const 列名 of ["联系电话", "决策状态"]) {
    await 菜单.getByText(列名, { exact: true }).click();
    await expect(菜单, `勾了「${列名}」之后单子不该收起来`).toBeVisible();
  }

  // 两列都出来了，说明两次点击都真的生效了（不是只有第一次）
  for (const 列名 of ["联系电话", "决策状态"]) {
    await expect(page.locator(".ant-table-thead th", { hasText: 列名 })).toBeVisible();
  }

  // 再点一次按钮才收——这是「自己再点击它就关闭」那一条
  await 列按钮.click();
  await expect(菜单).toBeHidden();
});

test("客户记录：左边有窄名单，切人不回列表", async ({ page }) => {
  await page.setViewportSize({ width: 1560, height: 900 });
  await 登录(page);
  await page.goto("/customers");
  await page.waitForSelector(".ant-table-row");
  await page.locator(".ant-table-row .link-strong").first().click();
  await expect(page).toHaveURL(/\/customers\/[^/]+$/);

  const 名单 = page.locator("aside.pane-roster");
  await expect(名单).toBeVisible();
  const 第一位 = page.url();

  // 点名单里的另一位：URL 换人，名单还在——不用退回列表再进去
  await 名单.locator(".roster-row").nth(1).click();
  await expect(page).not.toHaveURL(第一位);
  await expect(page).toHaveURL(/\/customers\/[^/]+$/);
  await expect(名单).toBeVisible();
});

test("客户记录：窄屏下名单收成抽屉，但「换一位」这条路还在", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await 登录(page);
  await page.goto("/customers");
  await page.waitForSelector(".ant-table-row");
  await page.locator(".ant-table-row .link-strong").first().click();
  await expect(page).toHaveURL(/\/customers\/[^/]+$/);

  await expect(page.locator("aside.pane-roster")).toHaveCount(0);
  const 按钮 = page.getByRole("button", { name: /换一位/ });
  await expect(按钮).toBeVisible();
  await 按钮.click();
  await expect(page.locator(".ant-drawer .roster-row").first()).toBeVisible();
});

/* ---------- 批 3 ---------- */

test("跟进计划：按逾期 / 今天 / 本周分三组，逾期那组是红的", async ({ page }) => {
  // 先清再造：前面几条已经造过一套，直接再造一次会撞渠道名的唯一约束
  const p = 连库();
  await 清空业务数据(p);
  await 造模拟数据(p);
  await p.$disconnect();

  await 登录(page);
  await page.goto("/follow-ups/plans");
  await page.waitForSelector(".plan-g");

  const 组名 = await page.locator(".plan-g-h b").allInnerTexts();
  expect(组名.slice(0, 3)).toEqual(["逾期", "今天", "本周"]);

  // 逾期不能只靠排在最前面：颜色得跟上，扫过去才看得见
  const 红 = await page.locator(".plan-g-warn .plan-g-h b").evaluate((el) => getComputedStyle(el).color);
  expect(红, "逾期那一组的标题没有标红").not.toBe("rgb(17, 24, 39)");

  // 每一组都要说清自己是什么，空的那组也要
  for (const 说明 of await page.locator(".plan-g-s").allInnerTexts()) {
    expect(说明.trim().length).toBeGreaterThan(3);
  }
});

test("完成一条计划之后，它去了「已完成」那一屏（不是人间蒸发）", async ({ page }) => {
  // 自带数据：这条用例单独跑（-g）时前面那条不会执行，库里一条计划都没有
  const p = 连库();
  await 清空业务数据(p);
  await 造模拟数据(p);
  await p.$disconnect();

  await 登录(page);
  await page.goto("/follow-ups/plans");
  await page.waitForSelector(".plan-g");
  // antd Segmented 的 radio 是隐藏 input，点不了，点标签本身。
  // 这一页有两个：第一个是「待办 / 已完成」，第二个是「我的 / 全部成员」
  const 视图 = page.locator(".ant-segmented").first();
  const 范围 = page.locator(".ant-segmented").nth(1);
  await 范围.getByText("全部成员", { exact: true }).click();

  // 先确认「已完成」那一屏此刻是空的，等会儿的 1 条才说明得了问题
  await 视图.getByText(/^已完成/).click();
  await expect(page.locator(".plan-row-was")).toHaveCount(0);

  await 视图.getByText("待办", { exact: true }).click();
  const 行 = page.locator(".plan-row").first();
  const 标题 = (await 行.locator(".plan-row-t").innerText()).trim();
  await 行.getByRole("button", { name: /^完成/ }).click();
  // 完成的那一行先留在原地 600ms 再消失（见 PlansView），之后这一页会重取
  await expect(page.locator(".plan-row-done")).toHaveCount(0, { timeout: 10_000 });

  /*
    这一条盯的是 2026-09-18 问到的那个缺口：原来点完成之后，那条计划
    在界面上再也找不到——「我上周排的回访到底做没做」没有地方答得上来。
    不去断言它从待办里消失：模拟数据里的标题会重样，那个断言验的是别的事。
  */
  await 视图.getByText(/^已完成/).click();
  await expect(page.locator(".plan-row-was")).toHaveCount(1);
  const 那条 = page.locator(".plan-row-was").first();
  await expect(那条).toContainText(标题);
  await expect(那条).toContainText("完成");
});

test("商机管道：列头写着这一阶段压着多少钱", async ({ page }) => {
  await 登录(page);
  await page.goto("/opportunities/pipeline");
  await page.waitForSelector(".pipe-col");
  const 合计 = await page.locator(".pipe-sum").allInnerTexts();
  expect(合计.length).toBeGreaterThan(0);
  for (const x of 合计) expect(x).toMatch(/¥|￥|\d/);
});

test("1024 下管道自己横滚，页面不跟着被撑开", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await 登录(page);
  await page.goto("/opportunities/pipeline");
  await page.waitForSelector(".pipe-col");

  const r = await page.evaluate(() => {
    const d = document.documentElement;
    const pipe = document.querySelector(".pipe")!;
    return {
      页面溢出: d.scrollWidth > d.clientWidth + 1,
      管道能横滚: pipe.scrollWidth > pipe.clientWidth,
    };
  });
  expect(r.页面溢出, "整页被管道撑出了横向滚动条").toBe(false);
  expect(r.管道能横滚, "管道那一块自己得能横滚，否则右边几列就看不到了").toBe(true);
});

/* ---------- 批 4 ---------- */

test("数据：三处看数并成一页，/reports 这条 URL 还在", async ({ page }) => {
  await 登录(page);
  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "数据", exact: true })).toBeVisible();

  // 三个视图，切过去地址跟着变
  const 切换 = page.locator(".ant-segmented");
  for (const v of ["本月", "本年"]) {
    await 切换.getByText(v, { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`view=${encodeURIComponent(v)}`));
    // 每一段的数都要写明是按什么口径算的
    await expect(page.locator(".stat-delta").first()).toContainText("按签约日期算");
  }

  // 老书签不能死
  await page.goto("/reports");
  await expect(page).toHaveURL(/view=/);
});

/**
 * 数据页正文里那个「问一个数」2026-09-19 撤了。
 *
 * 0.38 之后 AI 面板在每一页常驻，这一页就同屏摆了两个长得一样的框：
 * 正文那个只问数字、出图表，面板那个是完整的 agent。两件事确实不同，
 * 但人分不出来——只会以为坏了一个，或者不知道该用哪个。
 * 少一个框不丢能力：数字类问题面板照样答。
 */
test("数据页只剩面板那一个输入框，正文里不再有第二个", async ({ page }) => {
  await 登录(page);
  await page.goto("/overview");
  await expect(page.getByPlaceholder(/^问一个数/)).toHaveCount(0);

  // 面板那个还在，而且**只有它**——.cli-input 全站只该在面板里出现这一次
  await expect(page.locator("aside.dock .cli-input textarea")).toBeVisible();
  await expect(page.locator(".cli-input textarea")).toHaveCount(1);

  // 首页那个是整页的同一块，不受影响（首页不画面板）
  await page.goto("/dashboard");
  await expect(page.locator("aside.dock")).toHaveCount(0);
  const 首页框 = page.getByPlaceholder(/^问一位/);
  await expect(首页框).toBeVisible();
  await expect(首页框.locator("xpath=ancestor::*[contains(@class,'cli-input')]")).toHaveCount(1);
});

test("输入框：字多了就长高，长到头才在框内滚——不是永远一行", async ({ page }) => {
  await 登录(page);
  await page.goto("/dashboard");
  const ta = page.locator(".cli-input textarea");
  await ta.waitFor();
  const 一行 = (await ta.boundingBox())!.height;

  // 首页这个框里有回形针和模型那一条，所以它是 column flex。
  // .cli-input textarea 上的 flex:1 在 column 下作用在高度上，会把自适应高度顶掉——
  // 那正是「打了一大段字只看得见一行」的成因，这条就是钉住它别再回来
  await ta.fill("这是一句很长的问题".repeat(12));
  const 多行 = (await ta.boundingBox())!.height;
  expect(多行).toBeGreaterThan(一行 * 2);
  // 长到这个程度应该整段都看得见，不该在框里滚
  expect(await ta.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);

  // 再长就顶到上限，框自己滚，不无限撑页面
  await ta.fill("这是一句很长的问题".repeat(200));
  const 到顶 = (await ta.boundingBox())!.height;
  expect(到顶).toBeLessThanOrEqual(page.viewportSize()!.height * 0.45);
  expect(await ta.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  // 删回去要缩回来：发完一问框还占着半屏的话，下一问没法看
  await ta.fill("短");
  expect((await ta.boundingBox())!.height).toBeCloseTo(一行, 0);
});

test("⌘K：有输入框的页面回到输入框，没有的弹跳转单", async ({ page }) => {
  await 登录(page);

  // 首页有框：⌘K 是把光标放回去，不弹浮层
  await page.goto("/dashboard");
  await page.waitForSelector(".cli-input textarea");
  await page.locator("body").click();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".cli-input textarea")).toBeFocused();
  await expect(page.locator(".cmdk")).toHaveCount(0);

  // 列表页没框：弹单子，打字筛页面，回车跳过去
  await page.goto("/customers");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".cmdk")).toBeVisible();
  await page.keyboard.type("渠道");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/channels$/);

  /*
    数据页 2026-09-19 撤掉正文那个框之后也归入「没框」那一类——
    ⌘K 找的是面板**以外**的 .cli-input，这一页现在一个都没有。
    撤框是产品决定，⌘K 跟着变是连带后果，得钉住。
  */
  await page.goto("/overview");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".cmdk")).toBeVisible();
});

test("⌘K：一个页面都没匹配上时，第一条变成「问一句」", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("这个月谁签得最多");
  await expect(page.locator(".cmdk-row").first()).toContainText("问一句");
  await page.keyboard.press("Enter");
  // 带着问题落到首页——答案、过程、建议卡都在那儿
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.locator(".cli-bubble")).toContainText("这个月谁签得最多");
});

test("设置：左目录分两组、带搜索，一页上只有一列目录", async ({ page }) => {
  await 登录(page, 管理员);
  await page.goto("/settings");
  await page.waitForSelector(".set-nav");
  // 顺序按分组走，不按代码里谁先写。「我自己的」在前，「整个团队的」在后
  const 项 = await page.locator(".set-nav-i b").allInnerTexts();
  expect(项).toEqual(["个人资料", "登录与密码", "快捷键", "团队成员", "业务配置", "AI 接入", "导入记录", "操作日志"]);
  expect(await page.locator(".set-nav-h").allInnerTexts()).toEqual(["个人", "工作区"]);
  // 中栏撤了：一页上摆两列目录，人得先弄清它们有什么区别
  await expect(page.locator("aside.pane")).toHaveCount(0);
  // 每一项都得说清自己管什么
  for (const 说明 of await page.locator(".set-nav-i span").allInnerTexts()) {
    expect(说明.trim().length).toBeGreaterThan(3);
  }

  // 搜索：项数多了之后，「知道它叫什么、不知道在哪一栏」才是最常见的来访
  await page.getByLabel("搜索设置").fill("密码");
  expect(await page.locator(".set-nav-i b").allInnerTexts()).toEqual(["登录与密码"]);
  // 搜的时候不摆组标题：那时要的是一份短名单，不是结构
  await expect(page.locator(".set-nav-h")).toHaveCount(0);
  await page.getByLabel("搜索设置").fill("这个设置不存在");
  await expect(page.locator(".set-nav-empty")).toBeVisible();
});

test("个人资料：不是管理员也能改自己的名字，改完整站跟着变", async ({ page }) => {
  // 用销售登录——这条要钉的正是「不用求管理员」
  await 登录(page);
  await page.goto("/settings?tab=profile");
  await page.getByLabel("名字", { exact: true }).fill("张三改过的名字");
  // antd 会在两个汉字中间插空格，按钮的无障碍名字是「保 存」——别处也是这么绕的
  await page.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.locator(".ant-message")).toContainText("已保存");
  // 左下角那一行是同一个名字的另一处出口，revalidate 没生效的话它还是旧的
  await expect(page.locator(".rail-user b")).toHaveText("张三改过的名字");
  await page.getByLabel("名字", { exact: true }).fill("张三");
  await page.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.locator(".rail-user b")).toHaveText("张三");
});

test("AI 接入：没测过连接就保存会先拦一下", async ({ page }) => {
  await 登录(page, 管理员);
  await page.goto("/settings?tab=ai");
  /* 上一条用例已经存过自己的 Key，所以这一页进来就停在「用你自己的」那一屏 */
  await page.locator("#model").fill("e2e-model-2");
  await page.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByRole("dialog")).toContainText("还没测试过连接");
  await page.getByRole("button", { name: "先测一下" }).click();
  // 拦下来之后没有保存，提示也不该出现
  await expect(page.locator(".ant-message")).toHaveCount(0);
});

/* ---------- 收尾：指标落地、图表落地、联系人入口（2026-09-17 逐页核对后补的三件） ---------- */

test("数据「现在」那四张卡，每一张都点得进一个能把这个数重新数一遍的页面", async ({ page }) => {
  await 登录(page);
  await page.goto("/overview");

  /**
   * 设计稿 08/DATA·NOW 的页面规则：关键指标可跳到明细。
   * 四张卡换成了本月签约 / 新增客户 / 进行中商机 / 逾期跟进——
   * 四个「今天要关心什么」，而不是四个「库里有多少」。
   * 这条钉的是**每一张都真的落得了地**：一个点不进去的数只能让人干着急。
   */
  const 卡 = ["本月签约", "新增客户", "进行中商机", "逾期跟进"];
  const 名单 = await page.locator(".stat-label > span:first-child").allInnerTexts();
  expect(名单.map((t) => t.trim())).toEqual(卡);

  const 去处: Record<string, RegExp> = {
    本月签约: /\/overview\?view=/,
    新增客户: /\/customers\?createdWithin=/,
    进行中商机: /\/opportunities\?status=OPEN/,
    逾期跟进: /\/follow-ups\/plans/,
  };
  for (const 名 of 卡) {
    await page.goto("/overview");
    await page.locator(".stat-card-go", { hasText: 名 }).click();
    await expect(page, `${名} 这张卡点了没去处`).toHaveURL(去处[名]);
  }
});

test("从「新增客户」点进来时，列表要说清自己只是一个子集", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers?createdWithin=本月");
  // 不说的话，人会把这一屏当成全部
  await expect(page.getByText("只看本月新增")).toBeVisible();
  // 而且要给一条回到全部的路
  await page.locator(".ant-tag-close-icon").first().click();
  await expect(page).toHaveURL(/\/customers$/);
});

test("趋势图点一根柱子，看得到这一段是哪几笔凑出来的", async ({ page }) => {
  await 登录(page);
  await page.goto("/overview?view=" + encodeURIComponent("本年"));
  /*
    先把右边那块 AI 面板收起来（0.38 起它默认开着）。这条用例按**像素**在画布上扫着点，
    而面板一开正文就窄 380，柱子全挪了位，扫到的都是空白。
    要测的是「图能点开明细」，面板在不在不是这条的事。
  */
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.locator("aside.dock")).toHaveCount(0);
  const 图 = page.locator(".ant-card", { hasText: "签约金额趋势" });
  await expect(图).toContainText("点柱子或下面的日期");

  /*
    echarts 画在 canvas 上，没有可点的 DOM 节点，只能按像素点；
    而柱子落在哪个像素取决于这一年有几个月有签约、每根多高——在测试里不是定数。
    所以在图形区里扫一遍：**只要有一处点得开，这张图就是能点的**，
    这正是这条用例要钉的东西。扫不开才算红。
  */
  const 框 = await 图.locator("canvas").first().boundingBox();
  if (!框) throw new Error("趋势图没渲染出来");
  const 抽屉 = page.locator(".ant-drawer");
  let 点开了 = false;
  for (const fy of [0.55, 0.75, 0.9, 0.97]) {
    for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      await page.mouse.click(框.x + 框.width * fx, 框.y + 框.height * fy);
      if (await 抽屉.isVisible().catch(() => false)) {
        点开了 = true;
        break;
      }
    }
    if (点开了) break;
  }
  expect(点开了, "在趋势图上怎么点都打不开明细").toBe(true);

  await expect(抽屉).toContainText("签约明细");
  // 抽屉里那句合计必须和表里的行对得上——这是「明细」两个字的全部意义
  const 行数 = await 抽屉.locator(".ant-table-tbody tr.ant-table-row").count();
  await expect(抽屉).toContainText(`共 ${行数} 笔`);
});

test("联系人页能直接加一位，但第一格必须先选归属", async ({ page }) => {
  await 登录(page);
  await page.goto("/contacts");
  await page.getByRole("button", { name: /添加联系人/ }).click();

  const 弹窗 = page.getByRole("dialog");
  await expect(弹窗).toBeVisible();
  // 只填姓名就保存：得被拦住。没有归属的联系人没有意义
  await 弹窗.getByPlaceholder("王妈妈").fill("走查的家长");
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();
  await expect(弹窗.getByText(/请选择所属/)).toBeVisible();
  await expect(弹窗).toBeVisible();
});
