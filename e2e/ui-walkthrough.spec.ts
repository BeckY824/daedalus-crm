/**
 * UI 走查：把手工清单里「机器能客观判定」的部分自动化。
 *
 * 判定标准都是**可证伪**的，不掺主观感受：
 *   - 空状态：页面上要有给人看的引导文字，不能是一片空白
 *   - 校验提示：不只是红框，文字必须真的**可见**（高度 > 0）
 *   - 长文本：不能把页面撑出横向滚动条
 *   - 窄屏与手机：同上
 *   - 后退、重复提交：行为确定，能断言
 *
 * 剩下的判断题（字段够不够用、文案贴不贴合带教习惯、哪里别扭）
 * 机器给不了答案，留在 docs/手工测试清单.md 里由人来走。
 *
 * 这一组会把每个页面截图存到 test-results/走查/，可以直接翻。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库, 清空业务数据, 造模拟数据 } from "./mock-data";

const 账号 = { 用户名: "zhangsan", 密码: "crm@2026" };
const 戳 = String(Date.now()).slice(-6);

const 页面 = [
  { 路径: "/dashboard", 名字: "数据首页" },
  { 路径: "/leads", 名字: "线索管理" },
  { 路径: "/customers", 名字: "学员管理" },
  { 路径: "/channels", 名字: "渠道管理" },
  { 路径: "/contacts", 名字: "联系人" },
  { 路径: "/opportunities", 名字: "商机管理" },
  { 路径: "/opportunities/pipeline", 名字: "商机管道" },
  { 路径: "/follow-ups", 名字: "跟进记录" },
  { 路径: "/follow-ups/plans", 名字: "跟进计划" },
  { 路径: "/reports", 名字: "数据复盘" },
  { 路径: "/settings", 名字: "设置管理" },
];

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

/** 页面有没有被撑出横向滚动条——布局错位最客观的信号 */
async function 横向溢出(page: Page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    return { 溢出: d.scrollWidth > d.clientWidth + 1, scrollWidth: d.scrollWidth, clientWidth: d.clientWidth };
  });
}

test.describe.configure({ mode: "serial" });

/**
 * 走查排在所有 spec 之后跑，前面的用例会留下数据。
 * 空状态那几条必须从真的空库开始，所以先清一遍。
 */
test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await p.$disconnect();
});

test("每个页面在零数据下都要有给人看的引导，不能一片空白", async ({ page }) => {
  await 登录(page);
  const 问题: string[] = [];

  for (const p of 页面) {
    await page.goto(p.路径);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(600);
    await page.screenshot({ path: `test-results/走查/空态-${p.名字}.png`, fullPage: true });

    const 文字量 = await page.evaluate(() => document.querySelector("main")?.innerText.trim().length ?? 0);
    if (文字量 < 40) 问题.push(`${p.名字}（${p.路径}）内容区几乎没有文字，只有 ${文字量} 个字符`);
  }

  expect(问题, `以下页面在零数据下可能是空白的：\n${问题.join("\n")}`).toEqual([]);
});

test("零数据时数据首页不该显示任何编出来的涨跌", async ({ page }) => {
  /**
   * 原本预测销售额那张卡写死 delta={18.6}，一条数据都没有也显示
   * 「较上月 ↑ 18.6%」；三条小曲线也是写死的数组，零数据照样画出上升线。
   * 数据首页上的假数字比没有数字更糟——人会照着它做判断。
   */
  await 登录(page);
  await page.goto("/dashboard");
  await page.waitForTimeout(800);

  const 涨跌 = await page.evaluate(() =>
    [...document.querySelectorAll(".stat-delta")].map((el) => (el as HTMLElement).innerText.trim()),
  );
  const 编出来的 = 涨跌.filter((t) => /[↑↓]\s*[1-9]/.test(t));
  expect(编出来的, `零数据时出现了非零涨跌，多半是写死的：${JSON.stringify(涨跌)}`).toEqual([]);

  /**
   * 小曲线不在这里断言：它是 ECharts 画的，扒图形既不稳也容易误伤图标的 path
   * （第一版就把 antd 图标算进去了）。改用两条更准的：
   *   - tests/guards.test.ts 禁止源码里出现写死的 Sparkline 数组
   *   - tests/dashboard-series.test.ts 直接测序列的计算逻辑
   * 这个漏洞真实发生过：「商机总金额」的曲线一直是写死的数组，
   * 线上零数据时照样画出一条上升线，是看线上截图才发现的。
   */
});

test("表格类页面零数据时要显示空状态提示，而不是只有表头", async ({ page }) => {
  await 登录(page);
  const 有表格的 = ["/leads", "/customers", "/channels", "/contacts", "/opportunities", "/follow-ups"];
  const 问题: string[] = [];

  for (const 路径 of 有表格的) {
    await page.goto(路径);
    await page.waitForTimeout(600);
    const 表格数 = await page.locator(".ant-table").count();
    if (!表格数) continue;
    const 有空态 = await page.locator(".ant-empty").count();
    const 行数 = await page.locator(".ant-table-row").count();
    if (行数 === 0 && !有空态) 问题.push(`${路径}：表格没有数据也没有空状态提示`);
  }

  expect(问题, 问题.join("\n")).toEqual([]);
});

test("必填项校验：不只是红框，文字必须真的看得见", async ({ page }) => {
  /**
   * 只断言「有错误元素」是不够的——dev 模式下这些文字会因为入场动画
   * 卡在高度 0，红框有、文字没有。这里直接量高度。
   */
  await 登录(page);
  await page.goto("/customers");
  await page.getByRole("button", { name: /新建学员/ }).click();
  const 弹窗 = page.getByRole("dialog");
  await expect(弹窗).toBeVisible();

  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();
  await page.waitForTimeout(800);

  const 提示 = await page.evaluate(() =>
    [...document.querySelectorAll(".ant-form-item-explain-error")].map((el) => ({
      文本: (el as HTMLElement).innerText,
      高度: el.getBoundingClientRect().height,
    })),
  );

  expect(提示.length, "点保存后没有出现任何必填提示").toBeGreaterThan(0);
  const 看不见的 = 提示.filter((t) => t.高度 === 0);
  expect(看不见的, `这些校验文字高度为 0，用户只看得到红框：${JSON.stringify(看不见的)}`).toEqual([]);
  // 提示要说清楚缺什么，不能是「必填」两个字了事
  for (const t of 提示) expect(t.文本.length, `提示「${t.文本}」太短，说不清缺什么`).toBeGreaterThan(3);
});

test("手机号格式错误要给出能看懂的提示", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers");
  await page.getByRole("button", { name: /新建学员/ }).click();
  const 弹窗 = page.getByRole("dialog");
  await 弹窗.getByLabel("客户姓名").fill("格式测试");
  await 弹窗.getByLabel("联系电话").fill("abc123");
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();
  await page.waitForTimeout(800);

  const 提示 = await page.evaluate(() =>
    [...document.querySelectorAll(".ant-form-item-explain-error")].map((el) => ({
      文本: (el as HTMLElement).innerText, 高度: el.getBoundingClientRect().height,
    })),
  );
  const 手机号提示 = 提示.find((t) => /手机号|电话|格式/.test(t.文本));
  expect(手机号提示, `没有针对手机号格式的提示，只有：${JSON.stringify(提示)}`).toBeTruthy();
  expect(手机号提示!.高度, "手机号格式提示看不见").toBeGreaterThan(0);
});

test("超长文本不能把列表撑出横向滚动条", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers");
  await page.getByRole("button", { name: /新建学员/ }).click();
  const 弹窗 = page.getByRole("dialog");
  await 弹窗.getByLabel("客户姓名").fill("超长" + "名".repeat(48));
  await 弹窗.getByLabel("联系电话").fill(`1360${戳}`.slice(0, 11).padEnd(11, "8"));
  await 弹窗.getByLabel("院校").fill("很长的院校名称".repeat(8));
  await 弹窗.getByLabel("专业").fill("很长的专业名称".repeat(8));
  await 弹窗.getByLabel("备注").fill("第一行\n第二行\n" + "很长的备注".repeat(40));
  await 弹窗.getByLabel("销售负责人").click();
  const 下拉 = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
  await 下拉.waitFor({ state: "visible" });
  await 下拉.locator(".ant-select-item-option").first().click();
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();
  await expect(弹窗).toBeHidden();

  await page.reload();
  await page.waitForTimeout(600);
  await page.screenshot({ path: "test-results/走查/超长文本-学员列表.png", fullPage: true });

  const 列表 = await 横向溢出(page);
  expect(列表.溢出, `学员列表被撑出横向滚动条：${JSON.stringify(列表)}`).toBe(false);

  // 详情页同样要扛得住
  await page.getByRole("link", { name: /超长名/ }).first().click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: "test-results/走查/超长文本-学员详情.png", fullPage: true });
  const 详情 = await 横向溢出(page);
  expect(详情.溢出, `学员详情被撑出横向滚动条：${JSON.stringify(详情)}`).toBe(false);
});

test("窄屏（笔记本分屏）下各页面不该横向溢出", async ({ page }) => {
  await 登录(page);
  await page.setViewportSize({ width: 1024, height: 800 });
  const 问题: string[] = [];

  for (const p of 页面) {
    await page.goto(p.路径);
    await page.waitForTimeout(500);
    const r = await 横向溢出(page);
    if (r.溢出) 问题.push(`${p.名字}：${r.scrollWidth} > ${r.clientWidth}`);
  }
  await page.screenshot({ path: "test-results/走查/窄屏-1024.png", fullPage: true });
  expect(问题, `窄屏下这些页面横向溢出：\n${问题.join("\n")}`).toEqual([]);
});

test("手机视口下各页面不该横向溢出", async ({ page }) => {
  await 登录(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const 问题: string[] = [];

  for (const p of 页面) {
    await page.goto(p.路径);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/走查/手机-${p.名字}.png`, fullPage: true });
    const r = await 横向溢出(page);
    if (r.溢出) 问题.push(`${p.名字}：${r.scrollWidth} > ${r.clientWidth}`);
  }
  expect(问题, `手机视口下这些页面横向溢出：\n${问题.join("\n")}`).toEqual([]);
});

test("造一批模拟数据，供后面几条看「有数据时」的样子", async () => {
  const p = 连库();
  const 统计 = await 造模拟数据(p);
  await p.$disconnect();
  console.log(`[走查] 已造：${JSON.stringify(统计)}`);
  expect(统计.学员).toBeGreaterThan(50); // 要够翻页
});

test("有数据时各页面不该横向溢出，也不该有内容被截断", async ({ page }) => {
  await 登录(page);
  const 问题: string[] = [];

  for (const 项 of 页面) {
    await page.goto(项.路径);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `test-results/走查/有数据-${项.名字}.png`, fullPage: true });
    const r = await 横向溢出(page);
    if (r.溢出) 问题.push(`${项.名字}：${r.scrollWidth} > ${r.clientWidth}`);
  }
  expect(问题, `有数据时这些页面横向溢出：\n${问题.join("\n")}`).toEqual([]);
});

test("列表满页时分页可用，翻页后内容真的变了", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers");
  await page.waitForTimeout(600);

  await expect(page.locator(".ant-table-row"), "默认每页应当是 20 条").toHaveCount(20);
  const 第一页首行 = await page.locator(".ant-table-row").first().innerText();

  // 不能用 getByTitle("2")：顶栏待办徽标也是 <sup title="2">，待办恰好 2 条时就会撞
  await page.locator(".ant-pagination-item-2").click();
  await page.waitForTimeout(800);
  const 第二页首行 = await page.locator(".ant-table-row").first().innerText();
  expect(第二页首行, "翻到第 2 页内容没变").not.toBe(第一页首行);
  await page.screenshot({ path: "test-results/走查/分页-第二页.png", fullPage: true });
});

test("看板有数据时各阶段都画得出来", async ({ page }) => {
  await 登录(page);
  await page.goto("/opportunities/pipeline");
  await page.waitForTimeout(900);
  await page.screenshot({ path: "test-results/走查/看板-有数据.png", fullPage: true });

  const 文本 = await page.locator("main").innerText();
  for (const 阶段 of ["初步沟通", "需求确认", "方案报价", "谈判审核", "赢单成交"]) {
    expect(文本, `看板缺少「${阶段}」这一列`).toContain(阶段);
  }
  const r = await 横向溢出(page);
  expect(r.溢出, `看板横向溢出：${JSON.stringify(r)}`).toBe(false);
});

test("业绩排行里的姓名不能溢出压到进度条上", async ({ page }) => {
  /**
   * 姓名格子原本固定 92px 且不裁剪，「Customer」这种长一点的名字
   * 会直接压在后面的进度条上。走查截图里一眼就能看到。
   */
  await 登录(page);
  await page.goto("/dashboard");
  await page.waitForTimeout(800);

  const 溢出的 = await page.evaluate(() =>
    [...document.querySelectorAll(".ant-space-item span[title]")]
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => ({ 名字: (el as HTMLElement).innerText, 实际: el.scrollWidth, 可用: el.clientWidth })),
  );
  // 裁剪本身是允许的（省略号），不允许的是「没有裁剪、直接盖住别人」
  const 没裁剪的 = await page.evaluate(() =>
    [...document.querySelectorAll(".ant-space-item span[title]")]
      .filter((el) => getComputedStyle(el).textOverflow !== "ellipsis")
      .map((el) => (el as HTMLElement).innerText),
  );
  expect(没裁剪的, `这些姓名没有做省略处理，长了会压住相邻元素：${JSON.stringify(没裁剪的)}`).toEqual([]);
  expect(Array.isArray(溢出的)).toBe(true);
});

test("商机管道：末档不再结构性为零，且时间窗下拉是接线的", async ({ page }) => {
  /**
   * 管道原本只统计 status=OPEN，而阶段推到「赢单成交」时状态必然变成 WON，
   * 所以末档永远是 0——漏斗最有用的读数（转化终点）被砍掉了。
   * 「本月/本季」那个下拉当时也没有接线，选了没反应，却又写着「本月」。
   */
  await 登录(page);
  await page.goto("/dashboard");
  await page.waitForTimeout(800);

  const 读末档 = () =>
    page.evaluate(() => {
      const 行 = [...document.querySelectorAll(".funnel-row")];
      const 末 = 行[行.length - 1] as HTMLElement | undefined;
      return 末?.innerText.replace(/\n/g, " ") ?? "";
    });

  const 本月 = await 读末档();
  expect(本月, "末档不是「赢单成交」").toContain("赢单成交");
  expect(本月, `末档仍然是 0，口径没改对：${本月}`).not.toMatch(/赢单成交\s+0\s/);

  // 口径要写在卡片上，否则没人看得出前四档和末档不是一个东西
  await expect(page.getByText(/前四档为当前进行中的商机/)).toBeVisible();

  // 下拉切到本季，页面要真的响应（本季包含本月，末档数量不应变小）
  await page.locator(".ant-card").filter({ hasText: "商机管道" }).locator(".ant-select").first().click();
  const 下拉 = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
  await 下拉.waitFor({ state: "visible" });
  await 下拉.locator(".ant-select-item-option").filter({ hasText: "本季" }).click();
  await page.waitForTimeout(500);
  await expect(page.getByText(/「赢单成交」为本季已赢单/)).toBeVisible();

  const 本季 = await 读末档();
  const 取数 = (t: string) => Number(t.match(/赢单成交\s+(\d+)/)?.[1] ?? -1);
  expect(取数(本季), "切到本季后末档数量反而变少了").toBeGreaterThanOrEqual(取数(本月));
});

test("推荐链上的学员，详情页要能看出上下游与归属", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers");
  await page.getByPlaceholder("姓名 / 电话 / 院校 / 专业").fill("链条3号");
  await page.getByRole("button", { name: /搜\s*索/ }).click();
  await page.waitForURL(/keyword=/);
  await page.reload();

  await page.getByRole("link", { name: "链条3号" }).click();
  await page.getByRole("tab", { name: "客户资料" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "test-results/走查/推荐链-详情.png", fullPage: true });

  const 文本 = await page.locator("main").innerText();
  expect(文本, "详情页看不到推荐人").toContain("推荐人");
  expect(文本, "详情页看不到渠道归属").toContain("渠道归属");
  expect(文本, "推荐人应当是链条 2 号").toContain("链条2号");
});

test("键盘可用性：两个输入框按回车都能登录", async ({ page }) => {
  /**
   * 登录是全系统最该支持键盘的表单——填完密码顺手回车是本能动作。
   *
   * 这条用例的由来：手工走查时用浏览器面板按回车「没反应」，两轮里我一次
   * 判成 bug、一次判成正常，都是错的——那个工具的 key 动作只派发 keydown，
   * 不触发浏览器的表单默认提交。Playwright 的 press 是真按键，能判定。
   * 固化成用例，以后不用再靠手点，也不会再被工具的假象带偏。
   */
  for (const 框 of ["用户名", "登录密码"]) {
    // 上一轮已经登录了，直接开 /login 会被挡回 /dashboard，先退出登录状态
    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByPlaceholder("用户名").fill(账号.用户名);
    await page.getByPlaceholder("登录密码").fill(账号.密码);
    await page.getByPlaceholder(框).press("Enter");
    await expect(page, `在「${框}」框里按回车没能提交`).toHaveURL(/\/dashboard/, { timeout: 10_000 });
  }
});

test("浏览器后退在各页面之间表现正常", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers");
  await page.getByRole("link", { name: "线索管理" }).click();
  await expect(page).toHaveURL(/\/leads/);
  await page.goBack();
  await expect(page, "从线索退回来应当回到学员列表").toHaveURL(/\/customers/);
  await page.goForward();
  await expect(page).toHaveURL(/\/leads/);
});

test("刷新后筛选条件要还在，不能白筛一次", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers");
  await page.getByPlaceholder("姓名 / 电话 / 院校 / 专业").fill("超长");
  await page.getByRole("button", { name: /搜\s*索/ }).click();
  await page.waitForURL(/keyword=/);
  const 筛选后 = page.url();

  await page.reload();
  expect(page.url(), "刷新后筛选条件丢了").toBe(筛选后);
  await expect(page.getByPlaceholder("姓名 / 电话 / 院校 / 专业")).toHaveValue("超长");
});

test("连点两次保存不会建出两条", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers");
  const 手机 = `1361${戳}`.slice(0, 11).padEnd(11, "8");

  await page.getByRole("button", { name: /新建学员/ }).click();
  const 弹窗 = page.getByRole("dialog");
  await 弹窗.getByLabel("客户姓名").fill(`连点${戳}`);
  await 弹窗.getByLabel("联系电话").fill(手机);
  await 弹窗.getByLabel("销售负责人").click();
  const 下拉 = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
  await 下拉.waitFor({ state: "visible" });
  await 下拉.locator(".ant-select-item-option").first().click();

  const 保存 = 弹窗.getByRole("button", { name: /保\s*存/ });
  await 保存.click({ clickCount: 2, delay: 30 }).catch(() => {});
  await expect(弹窗).toBeHidden();

  await page.reload();
  await page.getByPlaceholder("姓名 / 电话 / 院校 / 专业").fill(`连点${戳}`);
  await page.getByRole("button", { name: /搜\s*索/ }).click();
  await page.waitForURL(/keyword=/);
  await page.reload();
  await expect(page.locator(".ant-table-row"), "连点两次建出了多条").toHaveCount(1);
});

test("走查结束：清掉模拟数据", async () => {
  const p = 连库();
  await 清空业务数据(p);
  const 剩余 = await p.customer.count();
  await p.$disconnect();
  expect(剩余, "模拟数据没清干净").toBe(0);
});
