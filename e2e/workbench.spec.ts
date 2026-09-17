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
  await page.goto("/settings?tab=ai");
  // AI 接入 2026-09-17 起是「两个选择」：先说要用自己的 Key，再选「其它」才出现接口地址
  await page.getByRole("radio", { name: /用我自己的 API Key/ }).click();
  await page.getByLabel("用哪一家").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").getByText("其它（自己填接口地址）").click();
  await page.locator("#baseUrl").fill("http://127.0.0.1:9/v1");
  // 纯 ASCII：中文塞进 Authorization 头会在 fetch 那一层就报错，掩盖掉真正的失败原因
  await page.locator("#apiKey").fill("e2e-not-a-real-key");
  await page.locator("#model").fill("e2e-model");
  await page.getByRole("button", { name: /保\s*存/ }).click();
  // 没测过连接会先拦一下：整套 AI 都走这套配置，地址不对会一起失灵
  await page.getByRole("button", { name: "仍然保存" }).click();
  await expect(page.locator(".ant-message")).toContainText("已保存");
});

test.afterAll(async () => {
  // 库里收拾干净就行。dev server 那边的设置缓存不用管：每轮 e2e 都是新库新进程
  const p = 连库();
  await p.setting.deleteMany({ where: { key: "llm" } });
  await 清空业务数据(p);
  await p.$disconnect();
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

test("学员列表：空库时不摆筛选栏，主动作还在原位", async ({ page }) => {
  const p = 连库();
  await 清空业务数据(p);
  await p.$disconnect();

  await 登录(page);
  await page.goto("/customers");
  await page.waitForSelector(".list");
  await expect(page.getByPlaceholder("姓名 / 电话 / 院校 / 专业")).toHaveCount(0);
  // 「新建」任何时候都在：空状态里那个是引导，不是它的替代品
  await expect(page.getByRole("button", { name: /新建学员/ })).toBeVisible();
});

test("学员列表：默认只摆六列，其余在「列」里", async ({ page }) => {
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

test("学员记录：左边有窄名单，切人不回列表", async ({ page }) => {
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

test("学员记录：窄屏下名单收成抽屉，但「换一位」这条路还在", async ({ page }) => {
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

test("问数据和首页用的是同一个输入框", async ({ page }) => {
  await 登录(page);
  await page.goto("/overview");
  await expect(page.locator(".cli-input textarea")).toBeVisible();
  await page.goto("/dashboard");
  await expect(page.locator(".cli-input textarea")).toBeVisible();
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

test("设置：左目录五项，一页上只有一列目录", async ({ page }) => {
  await 登录(page, 管理员);
  await page.goto("/settings");
  await page.waitForSelector(".set-nav");
  const 项 = await page.locator(".set-nav-i b").allInnerTexts();
  expect(项).toEqual(["团队成员", "登录与密码", "AI 接入", "业务配置", "操作日志"]);
  // 中栏撤了：一页上摆两列目录，人得先弄清它们有什么区别
  await expect(page.locator("aside.pane")).toHaveCount(0);
  // 每一项都得说清自己管什么
  for (const 说明 of await page.locator(".set-nav-i span").allInnerTexts()) {
    expect(说明.trim().length).toBeGreaterThan(3);
  }
});

test("AI 接入：没测过连接就保存会先拦一下", async ({ page }) => {
  await 登录(page, 管理员);
  await page.goto("/settings?tab=ai");
  /* 上一条用例已经存过自己的 Key，所以这一页进来就停在「用我自己的」那一屏 */
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
   * 四张卡换成了本月签约 / 新增学员 / 进行中商机 / 逾期跟进——
   * 四个「今天要关心什么」，而不是四个「库里有多少」。
   * 这条钉的是**每一张都真的落得了地**：一个点不进去的数只能让人干着急。
   */
  const 卡 = ["本月签约", "新增学员", "进行中商机", "逾期跟进"];
  const 名单 = await page.locator(".stat-label > span:first-child").allInnerTexts();
  expect(名单.map((t) => t.trim())).toEqual(卡);

  const 去处: Record<string, RegExp> = {
    本月签约: /\/overview\?view=/,
    新增学员: /\/customers\?createdWithin=/,
    进行中商机: /\/opportunities\?status=OPEN/,
    逾期跟进: /\/follow-ups\/plans/,
  };
  for (const 名 of 卡) {
    await page.goto("/overview");
    await page.locator(".stat-card-go", { hasText: 名 }).click();
    await expect(page, `${名} 这张卡点了没去处`).toHaveURL(去处[名]);
  }
});

test("从「新增学员」点进来时，列表要说清自己只是一个子集", async ({ page }) => {
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
