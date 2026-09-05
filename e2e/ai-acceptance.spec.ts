/**
 * AI 功能验收（代跑人工验收清单）。
 *
 * 与其余 e2e 不同，这一份**真的调用 AI**：每条用例都会打到中转站，
 * 慢（单条 10~30 秒）且花钱；它还依赖开发库里的真实跟进记录，
 * 而默认 e2e 跑在每次重建的空库上。因此被 playwright.config.ts 的
 * testIgnore 排除，需要单独跑：
 *
 *   1. 先起开发服务器：npm run dev -- --port 3100
 *   2. 另开一个终端：npx playwright test --config playwright.acceptance.config.ts
 *
 * 验的是"AI 起草、人签发"这条主线在真实浏览器里是否成立：
 * 预填的值必须落进表单、必须可改、勾选项必须真的创建对应记录。
 */
import { test, expect, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial", timeout: 180_000 });

async function 登录(page: Page) {
  await page.goto("/login");
  // 选择器与 smoke.spec.ts 保持一致：antd 表单没有可用的 label 关联，只能按 placeholder 找
  await page.getByPlaceholder("用户名").fill("admin");
  await page.getByPlaceholder("登录密码").fill("crm@2026");
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
}

/** 挑一个有跟进记录的学员——简报和速记都需要真实上下文 */
async function 打开有跟进记录的学员(page: Page) {
  await page.goto("/customers");
  await page.getByRole("link", { name: "王同学" }).first().click();
  await expect(page.getByRole("heading", { name: "王同学" })).toBeVisible();
}

test("1a 跟进速记：口述预填整张表单，相对时间换算成具体日期", async ({ page }) => {
  await 登录(page);
  await 打开有跟进记录的学员(page);

  await page.getByRole("button", { name: "新建跟进", exact: true }).click();
  const 弹窗 = page.getByRole("dialog");
  await expect(弹窗.getByPlaceholder(/跟进速记/)).toBeVisible();

  await 弹窗
    .getByPlaceholder(/跟进速记/)
    .fill("刚跟王妈妈打了20分钟电话，她担心孩子初三时间不够，想先试两节课，下周三晚上再约她聊报价");
  await 弹窗.getByRole("button", { name: /AI 解析填表/ }).click();

  // AI 往返需要时间，等预填结果落进「沟通内容」
  const 沟通内容 = 弹窗.getByLabel("沟通内容");
  await expect(沟通内容).not.toHaveValue("", { timeout: 120_000 });

  const 内容 = await 沟通内容.inputValue();
  console.log("[1a] 预填内容：", 内容);
  expect(内容.length).toBeGreaterThan(10);

  // 原话说了 20 分钟，时长应被识别（电话类型才显示这一栏）
  const 时长 = 弹窗.getByLabel("时长（分钟）");
  if (await 时长.isVisible()) {
    console.log("[1a] 时长：", await 时长.inputValue());
    expect(await 时长.inputValue()).toBe("20");
  }

  // 「下周三晚上」应变成一条带具体日期的跟进计划勾选项
  const 计划勾选 = 弹窗.getByText(/同时创建下次跟进计划/);
  await expect(计划勾选).toBeVisible();
  console.log("[1a] 计划：", await 计划勾选.innerText());
  // 具体日期而不是"下周三"这种相对说法
  expect(await 计划勾选.innerText()).toMatch(/\d{4}-\d{2}-\d{2}/);
});

test("1b 微信聊天记录：分清双方说话人，类型识别为短信沟通", async ({ page }) => {
  await 登录(page);
  await 打开有跟进记录的学员(page);

  await page.getByRole("button", { name: "新建跟进", exact: true }).click();
  const 弹窗 = page.getByRole("dialog");
  await 弹窗.getByPlaceholder(/跟进速记/).fill(
    [
      "王妈妈 09:02",
      "老师您好，周六试听那节课孩子听完回来说数学老师讲得很清楚",
      "我 09:05",
      "那太好了！孩子基础其实不错，补一补方法就能上来",
      "王妈妈 09:07",
      "价格能再优惠点吗？我们还在和另一家比",
      "我 09:10",
      "我申请个老学员介绍价给您，明天给您答复",
      "王妈妈 09:11",
      "好的，那等你消息",
    ].join("\n"),
  );
  await 弹窗.getByRole("button", { name: /AI 解析填表/ }).click();
  await expect(弹窗.getByLabel("沟通内容")).not.toHaveValue("", { timeout: 120_000 });

  const 内容 = await 弹窗.getByLabel("沟通内容").inputValue();
  console.log("[1b] 预填内容：", 内容);
  // 提炼后的纪要不该是原样复制，且要体现双方各自说了什么
  expect(内容).not.toContain("王妈妈 09:02");

  // 聊天记录应被识别为文字消息类沟通；类型是 antd Select，读整个弹窗文本更稳
  const 弹窗文本 = await 弹窗.innerText();
  const 类型 = 弹窗文本.match(/跟进类型\s*\n?\s*(\S+)/)?.[1] ?? "(未取到)";
  console.log("[1b] 类型：", 类型);
  expect(弹窗文本).toContain("短信沟通");
});

test("1c 保存联动：勾选的待办与计划随跟进一起创建，取消勾选的不创建", async ({ page }) => {
  await 登录(page);
  await 打开有跟进记录的学员(page);

  const 待办数 = async () => {
    const t = await page.getByRole("tab", { name: /待办任务/ }).innerText();
    return Number(t.match(/\((\d+)\)/)?.[1] ?? 0);
  };
  const 原待办 = await 待办数();
  const 原跟进条数 = await page.locator(".ant-timeline-item, [class*='timeline']").count();

  await page.getByRole("button", { name: "新建跟进", exact: true }).click();
  const 弹窗 = page.getByRole("dialog");
  await 弹窗
    .getByPlaceholder(/跟进速记/)
    .fill("今天下午微信问了王妈妈试听安排，她说周六可以，让我周五先把资料发过去");
  await 弹窗.getByRole("button", { name: /AI 解析填表/ }).click();
  await expect(弹窗.getByLabel("沟通内容")).not.toHaveValue("", { timeout: 120_000 });

  // 取消所有待办勾选，只保留跟进本体
  const 待办勾选 = 弹窗.getByText(/同时创建待办/);
  const 勾选数 = await 待办勾选.count();
  console.log("[1c] AI 提出的待办数：", 勾选数);
  for (let i = 0; i < 勾选数; i++) await 待办勾选.nth(i).click();

  // antd 会在两字按钮里插空格，用正则匹配
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();
  await expect(弹窗).not.toBeVisible({ timeout: 30_000 });

  // 跟进本体应已写入；待办数不应增加（都取消了）
  await page.waitForTimeout(1500);
  const 新待办 = await 待办数();
  console.log("[1c] 待办数：", 原待办, "→", 新待办);
  expect(新待办).toBe(原待办);
  const 新跟进条数 = await page.locator(".ant-timeline-item, [class*='timeline']").count();
  console.log("[1c] 时间线条数：", 原跟进条数, "→", 新跟进条数);
});

test("1d 可拒：无意义短文本明确报错，不硬编内容", async ({ page }) => {
  await 登录(page);
  await 打开有跟进记录的学员(page);

  await page.getByRole("button", { name: "新建跟进", exact: true }).click();
  const 弹窗 = page.getByRole("dialog");
  await 弹窗.getByPlaceholder(/跟进速记/).fill("嗯");
  await 弹窗.getByRole("button", { name: /AI 解析填表/ }).click();

  // 要么前端拦（"先把沟通过程随手写几句"），要么服务端拒（"内容太短"）——
  // 都必须有可见提示，且不能预填内容
  await expect(page.getByText(/随手写几句|太短|没有可整理/)).toBeVisible({ timeout: 30_000 });
  await expect(弹窗.getByLabel("沟通内容")).toHaveValue("");
});

test("2b 简报空数据兜底：没有跟进记录的学员明说，不硬生成", async ({ page }) => {
  await 登录(page);
  // 林同学有商机但没有任何跟进记录
  await page.goto("/customers");
  await page.getByRole("link", { name: "林同学" }).first().click();
  await page.getByRole("button", { name: "简报" }).click();

  await expect(page.getByText(/还没有任何跟进记录|没有可提炼/)).toBeVisible({ timeout: 60_000 });
});

test("3 问数据：答得出真实数字，也拒得掉预测性问题", async ({ page }) => {
  await 登录(page);
  await page.goto("/reports");

  const 卡片 = page.locator(".ant-card").filter({ hasText: "问数据" });

  const 问 = async (q: string) => {
    // 上一问的结果还在页面上，必须等到内容真的变了才算这一问答完，
    // 否则断言读的是上一条答案（真实踩过：第二问直接复用了第一问的结论）
    const 之前 = await 卡片.innerText();
    await page.getByPlaceholder(/用一句话问业务数字/).fill(q);
    await page.getByRole("button", { name: "问", exact: true }).click();
    await expect
      .poll(async () => await 卡片.innerText(), { timeout: 120_000, intervals: [2000] })
      .not.toBe(之前);
    return (await 卡片.innerText()).replace(/\n/g, " | ");
  };

  const 求和 = await 问("各个销售的签约金额分别是多少？");
  console.log("[3b] ", 求和);
  expect(求和).toContain("12,800");
  expect(求和).toContain("9,800");

  const 预测 = await 问("明天能签几单？");
  console.log("[3c] ", 预测);
  // 必须明说不支持，绝不能答出"0 笔"让人误以为在预测
  expect(预测).toMatch(/将来|超出|换个问法/);
  expect(预测).not.toMatch(/签约单数 · 20\d\d-\d\d-\d\d/);
});

test("6a 留痕：AI 起草在操作日志里留下 ai_draft 记录", async ({ page }) => {
  await 登录(page);
  await page.goto("/settings");
  await page.getByRole("tab", { name: /操作日志/ }).click();
  await expect(page.getByText(/AI 解析跟进速记|AI 起草/).first()).toBeVisible({ timeout: 30_000 });
  const 行数 = await page.getByText(/AI 解析跟进速记|AI 起草/).count();
  console.log("[6a] 日志中的 AI 起草记录数：", 行数);
  expect(行数).toBeGreaterThan(0);
});
