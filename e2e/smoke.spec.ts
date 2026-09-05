/**
 * 上线冒烟：把一条学员从线索走到签约，中间每一步都要在界面上看得见。
 *
 * 这些用例故意按业务链条前后依赖（串行执行），因为要验的正是「链条通不通」，
 * 而不是单个页面能不能打开。数据用同一个时间戳后缀，跑完能一眼认出来。
 */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const 账号 = { 用户名: "zhangsan", 密码: "crm@2026" };
const 管理员 = { 用户名: "admin", 密码: "crm@2026" };

/** 同一轮跑出来的数据带同样的后缀，避免和别轮撞名 */
const 戳 = String(Date.now()).slice(-6);
const 学员名 = `冒烟王${戳}`;
const 手机号 = `139${戳}0` .slice(0, 11).padEnd(11, "8");

/**
 * 提交一次登录，返回结果。
 *
 * 要重试是因为 dev 模式下页面可能还没水合：那时填进输入框的值只在 DOM 上，
 * React 接管后会被受控组件重置，点击也没有监听器接——表现就是点了没反应。
 * 生产构建下极少出现，但本地跑 E2E 必须扛住，否则每次首条用例都是假红。
 */
async function 提交登录(page: Page, who: { 用户名: string; 密码: string }) {
  await page.goto("/login");
  // antd v6 的 Alert 没有 role="alert"，只能按类名找
  const 提示 = page.locator(".ant-alert");

  for (let i = 0; i < 3; i++) {
    await page.getByPlaceholder("用户名").fill(who.用户名);
    await page.getByPlaceholder("登录密码").fill(who.密码);
    await page.getByRole("button", { name: /登\s*录/ }).click();

    // 成功会跳转，失败会出提示，两者都轮询，最多等 8 秒
    for (let t = 0; t < 40; t++) {
      if (/\/dashboard/.test(page.url())) return "ok" as const;
      if (await 提示.isVisible().catch(() => false)) return "err" as const;
      await page.waitForTimeout(200);
    }
  }
  throw new Error("登录表单点了没反应，可能是页面没水合");
}

async function 登录(page: Page, who = 账号) {
  const r = await 提交登录(page, who);
  expect(r, "应当登录成功").toBe("ok");
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe.configure({ mode: "serial" });

test("1. 密码错了要有明确提示，正确才放进来", async ({ page }) => {
  const r = await 提交登录(page, { 用户名: 账号.用户名, 密码: "这不是密码" });
  expect(r).toBe("err");
  await expect(page.locator(".ant-alert")).toContainText("密码错误");
  await expect(page).toHaveURL(/\/login/);

  await 登录(page);
  await expect(page.getByText("数据首页")).toBeVisible();
});

test("2. 未登录访问内页会被挡回登录页", async ({ page }) => {
  await page.goto("/customers");
  await expect(page).toHaveURL(/\/login/);
});

test("3. 新建线索后能在列表里看到", async ({ page }) => {
  await 登录(page);
  await page.getByRole("link", { name: "线索管理" }).click();
  await expect(page).toHaveURL(/\/leads/);

  await page.getByRole("button", { name: /新建线索/ }).click();
  const 弹窗 = page.getByRole("dialog");
  await 弹窗.getByLabel("线索名称").fill(学员名);
  await 弹窗.getByLabel("联系人").fill(学员名);
  await 弹窗.getByLabel("联系电话").fill(手机号);
  await 弹窗.getByRole("button", { name: /确\s*定|保\s*存/ }).click();

  await expect(page.getByRole("cell", { name: 学员名 }).first()).toBeVisible();
});

test("4. 线索转学员：学员库出现，线索标记已转化", async ({ page }) => {
  await 登录(page);
  await page.goto("/leads");

  const 行 = page.getByRole("row", { name: new RegExp(学员名) });
  await 行.getByRole("button", { name: "转客户" }).click();

  // 转化是不可逆的，界面会先要一次确认
  const 确认框 = page.getByRole("dialog");
  await expect(确认框).toContainText("转为客户");
  await 确认框.getByRole("button", { name: /转为客户/ }).click();

  // 转完直接跳到该学员详情
  await expect(page).toHaveURL(/\/customers\//);
  await expect(page.getByRole("heading", { name: 学员名 })).toBeVisible();

  // 线索那边要留下痕迹，不能转完就查无此事
  await page.goto("/leads");
  await expect(行).toContainText("已转化");
  await expect(行.getByRole("link", { name: /查看客户/ })).toBeVisible();
});

test("5. 给学员录一条跟进，时间线上要看得见", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers");
  await page.getByRole("link", { name: 学员名 }).click();

  await page.getByRole("button", { name: /新建跟进/ }).first().click();
  const 弹窗 = page.getByRole("dialog");
  await 弹窗.getByLabel("标题").fill("首次电话沟通");
  await 弹窗.getByLabel("沟通内容").fill("介绍了课程与价格");
  await 弹窗.getByRole("button", { name: /保\s*存|确\s*定/ }).click();

  /**
   * 断言的是沟通内容而不是标题：时间线上只渲染跟进类型和内容，
   * 标题虽然是必填却不展示在这里（见 TESTING.md 的已知缺口）。
   */
  await expect(page.getByText("介绍了课程与价格")).toBeVisible();
  await expect(page.getByText("电话沟通").first()).toBeVisible();
  // 刷新后仍在，才说明真的落库了而不只是界面上挂了一条
  await page.reload();
  await expect(page.getByText("介绍了课程与价格")).toBeVisible();
});

test("6. 登记签约后，跟进状态变成已签约、金额显示出来", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers");
  await page.getByRole("link", { name: 学员名 }).click();

  await page.getByRole("tab", { name: /签约/ }).click();
  await page.getByRole("button", { name: /登记签约|新建签约|添加签约/ }).first().click();
  const 弹窗 = page.getByRole("dialog");
  await 弹窗.getByLabel("签约金额（元）").fill("19800");
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();

  await expect(page.getByText("已签约").first()).toBeVisible();
  await expect(page.getByText(/19,800/).first()).toBeVisible();
});

test("7. 同一天同金额再录一笔，要弹窗确认而不是默默翻倍", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers");
  await page.getByRole("link", { name: 学员名 }).click();
  await page.getByRole("tab", { name: /签约/ }).click();

  await page.getByRole("button", { name: /登记签约|新建签约|添加签约/ }).first().click();
  const 弹窗 = page.getByRole("dialog").first();
  await 弹窗.getByLabel("签约金额（元）").fill("19800");
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();

  const 查重弹窗 = page.getByRole("dialog", { name: "这笔签约可能已经录过了" });
  await expect(查重弹窗).toBeVisible();
  await expect(查重弹窗).toContainText("重复录入会让业绩合计翻倍");
  await expect(查重弹窗).toContainText("19,800");

  // 点取消就不该录进去，累计金额保持一笔
  await 查重弹窗.getByRole("button", { name: /取\s*消/ }).click();
  await page.reload();
  await page.getByRole("tab", { name: /签约/ }).click();
  await expect(page.getByRole("tab", { name: /签约/ })).toContainText("(1)");
  await expect(page.getByText(/累计签约/)).toContainText("19,800");
});

test("8. 两个人同时改同一条学员：改不同字段自动合并，改同一字段才拦", async ({ browser }) => {
  /**
   * 两个独立的 browser context = 两套互不干扰的 Cookie，
   * 一台机器就能模拟两个人同时在线，不需要第二台机器。
   */
  const 甲上下文 = await browser.newContext();
  const 乙上下文 = await browser.newContext();
  const 甲 = await 甲上下文.newPage();
  const 乙 = await 乙上下文.newPage();

  await 登录(甲, 账号);
  await 登录(乙, 管理员);

  async function 打开编辑框(page: Page) {
    await page.goto("/customers");
    await page.getByRole("row", { name: new RegExp(学员名) }).getByRole("button").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
  }

  // 两人同时打开同一条
  await 打开编辑框(甲);
  await 打开编辑框(乙);

  // 甲改院校，乙改专业——不是同一项，都该存下
  await 甲.getByRole("dialog").getByLabel("院校").fill("北京大学");
  await 甲.getByRole("dialog").getByRole("button", { name: /保\s*存/ }).click();
  await expect(甲.getByText("已保存")).toBeVisible();

  await 乙.getByRole("dialog").getByLabel("专业").fill("软件工程");
  await 乙.getByRole("dialog").getByRole("button", { name: /保\s*存/ }).click();
  await expect(乙.getByText("已保存")).toBeVisible();

  // 两人的改动都在
  await 甲.goto("/customers");
  await expect(甲.getByRole("row", { name: new RegExp(学员名) })).toContainText("北京大学");
  await expect(甲.getByRole("row", { name: new RegExp(学员名) })).toContainText("软件工程");

  // 这次两人改同一项，后提交的必须被拦下
  await 打开编辑框(甲);
  await 打开编辑框(乙);
  await 甲.getByRole("dialog").getByLabel("院校").fill("清华大学");
  await 甲.getByRole("dialog").getByRole("button", { name: /保\s*存/ }).click();
  await expect(甲.getByText("已保存")).toBeVisible();

  await 乙.getByRole("dialog").getByLabel("院校").fill("复旦大学");
  await 乙.getByRole("dialog").getByRole("button", { name: /保\s*存/ }).click();
  await expect(乙.getByText("有人和你改了同一项，你的改动没有保存")).toBeVisible();
  await expect(乙.getByRole("dialog")).toContainText("院校");

  // 甲的值保住了
  await 甲.goto("/customers");
  await expect(甲.getByRole("row", { name: new RegExp(学员名) })).toContainText("清华大学");

  await 甲上下文.close();
  await 乙上下文.close();
});

test("9. 筛选后导出 CSV：行数对得上、中文不乱码、公式不会被带出去", async ({ page }) => {
  /**
   * 导出的去向是财务对账，所以这条验的是「导出来的文件能直接用」：
   * Excel 认的 BOM 在不在、筛选条件有没有被忽略、
   * 用户在备注里写的 =1+1 会不会变成公式。
   */
  await 登录(page);

  // 在一个「会被导出的」自由文本字段里埋一个公式。
  // 备注不在导出列里，所以这里用专业——载荷必须落在真的会导出的列上，
  // 否则这条断言等于没测（第一版就是这么写的，白跑了一轮）。
  await page.goto("/customers");
  await page.getByRole("row", { name: new RegExp(学员名) }).getByRole("button").first().click();
  const 编辑框 = page.getByRole("dialog");
  await 编辑框.getByLabel("专业").fill("=1+1");
  await 编辑框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(编辑框).toBeHidden();

  // 用姓名筛出唯一一条，导出的行数应当跟着筛选走
  await page.getByPlaceholder("姓名 / 电话 / 院校 / 专业").fill(学员名);
  await page.getByRole("button", { name: /搜\s*索/ }).click();
  /**
   * 必须等 URL 真的带上筛选条件再刷新。搜索是 startTransition 里的
   * router.push，异步的；点完就 reload 会抢在它前面，把筛选条件冲掉，
   * 结果导出的是全量数据——第一版就是这么写的，而且当时的断言
   * （按姓名匹配行数 === 1）在 9 行里也成立，等于没测到筛选。
   */
  await page.waitForURL(/keyword=/);
  // 软导航会命中 staleTimes=60 的路由缓存（见 A 组用例），硬刷新一次拿最新
  await page.reload();

  // 表格里确实只剩这一条——这才是「筛选生效」的证据
  await expect(page.locator(".ant-table-row")).toHaveCount(1);
  await expect(page.getByRole("row", { name: new RegExp(学员名) })).toHaveCount(1);

  const [下载] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /导\s*出/ }).click(),
  ]);
  const 文件 = await 下载.path();
  expect(文件, "没拿到导出的文件").toBeTruthy();
  const 内容 = readFileSync(文件!, "utf8");

  // 1. Excel 认的 BOM 必须在，否则中文一片乱码
  expect(内容.codePointAt(0), "缺少 BOM，Excel 打开会乱码").toBe(0xfeff);

  // 2. 中文表头与数据都要能原样读出来
  expect(内容).toContain("客户姓名");
  expect(内容).toContain(学员名);

  // 3. 行数 = 表头 1 行 + 筛选出的 1 行
  const 行 = 内容.replace(/^\ufeff/, "").split("\r\n").filter((l) => l.trim());
  expect(行, `导出行数与筛选结果对不上：\n${内容}`).toHaveLength(2);

  // 4. 用户填的公式被前缀成纯文本，不会在 Excel 里执行
  expect(内容).toContain("'=1+1");

  expect(下载.suggestedFilename()).toMatch(/学员列表-\d{4}-\d{2}-\d{2}\.csv/);
});
