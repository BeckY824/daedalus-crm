/**
 * 正在答的时候再问一句：排队，等上一问答完自动发出去（HomeChat 的「排队的下一问」）。
 *
 * 2026-10-20 把那段 effect 改成 useEffectEvent（去掉 exhaustive-deps 警告，行为不变），之前没有用例钉它。
 * 首页（宽）和全局面板（窄，一页一屏）各走一遍：
 *   1. 第一问的流先卡住不放
 *   2. 这时再问第二句：不并发，后端只收到一个请求
 *   3. 放开第一问：第二句自动发出去，带的是第二句的问题，答案出现在同一屏
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { 装个假模型, 拆掉假模型 } from "./fake-llm";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };

test.beforeAll(async ({ browser }) => 装个假模型(browser));
test.afterAll(async ({ browser }) => 拆掉假模型(browser));

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
  throw new Error("登录超时");
}

const 流 = (回答: string) =>
  [
    { type: "step", id: "answer", label: "组织回答", status: "running" },
    { type: "token", text: 回答 },
    { type: "step", id: "answer", label: "组织回答", status: "done" },
    { type: "result", ok: true, answer: { text: 回答, records: [], customers: [], proposals: [] } },
  ]
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .join("");

/** 第一问的请求卡住，直到 放开() ；之后的请求都立刻答。返回收到过的问题 */
async function 卡住第一问(page: Page) {
  const 收到: string[] = [];
  let 放开!: () => void;
  const 闸 = new Promise<void>((r) => (放开 = r));
  await page.route("**/api/ai/stream", async (route) => {
    const 问题 = String(route.request().postDataJSON()?.question ?? "");
    收到.push(问题);
    if (收到.length === 1) await 闸;
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
      body: 流(`答：${问题}`),
    });
  });
  return { 收到, 放开: () => 放开() };
}

async function 走一遍排队(page: Page, 区域: Locator) {
  const { 收到, 放开 } = await 卡住第一问(page);
  const 框 = 区域.locator("textarea").first();
  await 框.fill("排队用例第一问");
  await 框.press("Enter");
  await expect.poll(() => 收到.length).toBe(1);
  await expect(框).toHaveAttribute("placeholder", /再问会排队/);

  await 框.fill("排队用例第二问");
  await 框.press("Enter");
  // 正在答：第二句只排上队，不并发打后端
  await page.waitForTimeout(800);
  expect(收到).toEqual(["排队用例第一问"]);

  放开();
  await expect(区域).toContainText("答：排队用例第一问");
  // 第一问一答完，排着的那句自己发出去
  await expect.poll(() => 收到).toEqual(["排队用例第一问", "排队用例第二问"]);
  await expect(区域).toContainText("答：排队用例第二问");
}

test.describe("正在答时再问：排队、答完自动发", () => {
  test.use({ viewport: { width: 1680, height: 1000 } });

  test("首页", async ({ page }) => {
    await 登录(page);
    await page.goto("/dashboard");
    await 走一遍排队(page, page.locator("main"));
  });

  test("全局面板（别的页面上顺手问）", async ({ page }) => {
    await 登录(page);
    await page.goto("/channels");
    const 面板 = page.locator("aside.dock");
    await expect(面板).toBeVisible();
    await 走一遍排队(page, 面板);
  });
});
