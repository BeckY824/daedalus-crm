import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * 托管版走查：注册 → 用起来 → 到期 → 开通。
 *
 * 这套的重点是**用户看得见的隔离**：单测已经证明两个库互相读不到，
 * 这里证明「另一个人注册进来，在界面上确实看不到你的客户」。
 * 那才是能拿给人看的证据。
 *
 * 用例前后依赖（第二个账号要在第一个建了数据之后注册），所以串行。
 */
const ROOT = path.resolve(__dirname, "..");
const CONTROL_DB = path.join(ROOT, "prisma/e2e-hosted/control.db");

/** 直接改控制面库：把某个工作区的试用到期日拨到过去 */
function 拨到过期(workspaceName: string) {
  execFileSync("node", ["--experimental-sqlite", "-e", `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.prepare("UPDATE Workspace SET trialEndsAt = ? WHERE name = ?").run(Date.now() - 86400000, process.argv[2]);
    db.close();
  `, CONTROL_DB, workspaceName], { stdio: "pipe" });
}

async function 注册(page: Page, opts: { 团队: string; 姓名: string; 手机: string; 密码: string }) {
  await page.goto("/signup");
  await page.getByPlaceholder("团队名称，如「启明教育」").fill(opts.团队);
  await page.getByPlaceholder("你的姓名").fill(opts.姓名);
  await page.getByPlaceholder("手机号或邮箱").fill(opts.手机);
  await page.getByRole("button", { name: "获取验证码" }).click();

  // 开发环境把验证码回显在提示条里，省掉真发短信
  const 提示 = page.locator(".ant-alert").filter({ hasText: "开发环境验证码" });
  await expect(提示).toBeVisible({ timeout: 15_000 });
  const 码 = (await 提示.textContent())?.match(/\d{6}/)?.[0];
  expect(码, "开发环境应当回显验证码").toBeTruthy();

  await page.getByPlaceholder("验证码").fill(码!);
  await page.getByPlaceholder("设置密码").fill(opts.密码);
  await page.getByRole("button", { name: "创建工作区" }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
}

async function 登出(page: Page) {
  await page.request.post("/api/auth/logout");
  await page.context().clearCookies();
}

test("1 注册就得到一个属于自己的空工作区", async ({ page }) => {
  await 注册(page, { 团队: "启明教育", 姓名: "林老师", 手机: "13800138000", 密码: "qiming2026" });
  await expect(page.getByText("林老师")).toBeVisible();

  await page.goto("/customers");
  // 全新工作区：一条业务数据都不该有
  await expect(page.getByRole("cell", { name: "暂无数据" }).or(page.getByText("暂无数据"))).toBeVisible({ timeout: 15_000 });
});

test("2 建一条客户，自己看得到", async ({ page }) => {
  await page.goto("/customers");
  await page.getByRole("button", { name: "新建学员", exact: true }).click();
  const 弹窗 = page.getByRole("dialog");
  await 弹窗.getByLabel("客户姓名").fill("启明的客户甲");
  await 弹窗.getByLabel("联系电话").fill("13900001111");
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText("启明的客户甲")).toBeVisible({ timeout: 15_000 });
});

test("3 另一个人注册进来，看不到上一家的客户", async ({ page }) => {
  await 登出(page);
  await 注册(page, { 团队: "北辰网络", 姓名: "赵经理", 手机: "13900139000", 密码: "beichen2026" });

  await page.goto("/customers");
  await expect(page.getByText("赵经理")).toBeVisible();
  // 这是隔离的用户可见证明
  await expect(page.getByText("启明的客户甲")).toHaveCount(0);
});

test("4 试用到期后只读：横条出现，写操作被拒", async ({ page }) => {
  拨到过期("北辰网络");
  // 租户解析按 token 缓存 10 秒，等它过期再看
  await page.waitForTimeout(11_000);

  await page.goto("/dashboard");
  await expect(page.getByText(/试用已结束/)).toBeVisible({ timeout: 15_000 });

  // 界面上拦不拦不重要，服务端必须拦住——Server Action 是公开端点
  await page.goto("/customers");
  await page.getByRole("button", { name: "新建学员", exact: true }).click();
  const 弹窗 = page.getByRole("dialog");
  await 弹窗.getByLabel("客户姓名").fill("到期后不该写进去");
  await 弹窗.getByLabel("联系电话").fill("13900002222");
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();

  await expect(page.getByText(/试用已结束|开通订阅/).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("到期后不该写进去")).toHaveCount(0);
});

test("5 开通页：说清怎么付，提交后等核对", async ({ page }) => {
  await page.goto("/billing");
  await expect(page.getByRole("heading", { name: "开通订阅" })).toBeVisible();
  await expect(page.getByText(/只读状态/)).toBeVisible();

  await page.getByPlaceholder("转账单号 / 流水号").fill("TESTREF20260913");
  await page.getByRole("button", { name: /我已付款/ }).click();
  await expect(page.getByText(/已收到你的付款信息/)).toBeVisible({ timeout: 15_000 });

  // 关键约定：自己提交付款**不会**延长有效期，仍然是只读
  await page.goto("/dashboard");
  await expect(page.getByText(/试用已结束/)).toBeVisible({ timeout: 15_000 });
});

test("6 运营台要 token，开通后恢复可写", async ({ page }) => {
  // 不带 token 时这个页面不存在
  const 无票 = await page.goto("/admin");
  expect(无票?.status()).toBe(404);

  await page.goto("/admin?token=e2e-admin-token");
  await expect(page.getByRole("heading", { name: "工作区" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("北辰网络")).toBeVisible();
  await expect(page.getByText(/待核对/).first()).toBeVisible();

  // 给北辰开通
  const 行 = page.getByRole("row").filter({ hasText: "北辰网络" });
  await 行.getByRole("button", { name: "开通" }).click();
  await page.getByRole("button", { name: /确\s*定|OK/ }).click();
  await expect(page.getByText(/已更新/)).toBeVisible({ timeout: 15_000 });

  await page.waitForTimeout(11_000);
  await page.goto("/customers");
  // 开通之后横条消失，又能写了
  await expect(page.getByText(/试用已结束/)).toHaveCount(0);
  await page.getByRole("button", { name: "新建学员", exact: true }).click();
  const 弹窗 = page.getByRole("dialog");
  await 弹窗.getByLabel("客户姓名").fill("开通后的客户");
  await 弹窗.getByLabel("联系电话").fill("13900003333");
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText("开通后的客户")).toBeVisible({ timeout: 15_000 });
});

test("7 登出后注册与登录页可达，其余弹回登录", async ({ page }) => {
  await 登出(page);
  await page.goto("/signup");
  await expect(page.getByRole("button", { name: "创建工作区" })).toBeVisible();

  await page.goto("/customers");
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
});
