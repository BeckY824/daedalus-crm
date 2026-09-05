/**
 * 安全组的浏览器端部分。
 *
 * 存储型 XSS 只能在真浏览器里验：要看的是「脚本会不会被执行」，
 * 在 Node 里断言字符串里有没有尖括号毫无意义——
 * 转义与否取决于渲染时怎么插进 DOM，不取决于存了什么。
 */
import { test, expect, type Page } from "@playwright/test";

const 账号 = { 用户名: "zhangsan", 密码: "crm@2026" };
const 戳 = String(Date.now()).slice(-6);

/** 几种常见载荷：标签注入、属性事件、伪协议 */
const 载荷 = [
  '<script>window.__被执行了=1</script>',
  '<img src=x onerror="window.__被执行了=1">',
  '"><svg onload="window.__被执行了=1">',
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

test.describe.configure({ mode: "serial" });

test("存储型 XSS：学员备注里的脚本不会被执行，按字面显示", async ({ page }) => {
  const 弹窗数 = { n: 0 };
  page.on("dialog", async (d) => { 弹窗数.n++; await d.dismiss(); });

  await 登录(page);
  const 姓名 = `XSS${戳}`;

  await page.goto("/customers");
  await page.getByRole("button", { name: /新建学员/ }).click();
  const 表单 = page.getByRole("dialog");
  await 表单.getByLabel("客户姓名").fill(姓名);
  await 表单.getByLabel("联系电话").fill(`1375${戳}`.slice(0, 11).padEnd(11, "8"));
  await 表单.getByLabel("备注").fill(载荷.join("\n"));
  await 表单.getByLabel("销售负责人").click();
  const 下拉 = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
  await 下拉.waitFor({ state: "visible" });
  await 下拉.locator(".ant-select-item-option").first().click();
  await 表单.getByRole("button", { name: /保\s*存/ }).click();
  await expect(表单).toBeHidden();

  // 重新加载，走的是「从库里读出来再渲染」这条路——存储型 XSS 真正发作的时机
  await page.goto("/customers");
  await page.getByRole("link", { name: 姓名 }).click();
  await page.getByRole("tab", { name: "客户资料" }).click();

  // 1. 脚本没有执行
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__被执行了)).toBeUndefined();
  expect(弹窗数.n, "弹出了对话框，说明载荷被执行了").toBe(0);

  // 2. 没有真的往 DOM 里插进标签
  const 注入的元素 = await page.evaluate(() =>
    document.querySelectorAll("script[data-x], img[onerror], svg[onload]").length,
  );
  expect(注入的元素).toBe(0);

  // 3. 内容按字面显示出来，不是被吞掉了——转义正确的表现是「看得见但不生效」
  await expect(page.getByText("<script>", { exact: false }).first()).toBeVisible();
});

test("存储型 XSS：跟进内容同样不会被执行", async ({ page }) => {
  const 弹窗数 = { n: 0 };
  page.on("dialog", async (d) => { 弹窗数.n++; await d.dismiss(); });

  await 登录(page);
  await page.goto("/customers");
  await page.getByRole("link", { name: `XSS${戳}` }).click();

  await page.getByRole("button", { name: /新建跟进/ }).first().click();
  const 表单 = page.getByRole("dialog");
  await 表单.getByLabel("标题").fill(`跟进${戳}`);
  await 表单.getByLabel("沟通内容").fill(载荷.join(" "));
  await 表单.getByRole("button", { name: /保\s*存|确\s*定/ }).click();
  await expect(表单).toBeHidden();

  await page.reload();
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__被执行了)).toBeUndefined();
  expect(弹窗数.n).toBe(0);
  await expect(page.getByText("onerror", { exact: false }).first()).toBeVisible();
});

test("登录失败到阈值后会被限流，且提示说明要等多久", async ({ page }) => {
  await page.goto("/login");
  const 提示 = page.locator(".ant-alert");

  // 连续用错密码试，直到被限流为止
  let 被限流 = false;
  for (let i = 0; i < 8 && !被限流; i++) {
    await page.getByPlaceholder("用户名").fill("lisi");
    await page.getByPlaceholder("登录密码").fill(`错的密码${i}`);
    await page.getByRole("button", { name: /登\s*录/ }).click();
    await expect(提示).toBeVisible();
    被限流 = /失败次数过多/.test(await 提示.innerText());
  }

  expect(被限流, "连试 8 次都没有被限流，撞库脚本可以不限速地试").toBe(true);
  await expect(提示).toContainText(/分钟后再试/);
});
