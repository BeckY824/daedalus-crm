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

/**
 * 每次注册从控制面库里取一个还没用过的激活码。
 * 不能用模块级计数器：Playwright 在某条用例失败后会重启 worker，计数器归零，
 * 后面的用例就会拿到已经用掉的码——第一次跑第 9 条时就是这么挂的。
 */
function 下一个码(): string {
  return execFileSync("node", ["--experimental-sqlite", "-e", `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    const r = db.prepare('SELECT code FROM "ActivationCode" WHERE "usedAt" IS NULL ORDER BY code LIMIT 1').get();
    if (!r) throw new Error('激活码用完了：hosted-setup 里预置的不够');
    process.stdout.write(r.code);
    db.close();
  `, CONTROL_DB], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function 注册(page: Page, opts: { 团队: string; 姓名: string; 手机: string; 密码: string }) {
  await page.goto("/signup");
  await page.getByPlaceholder("团队名称，如「启明教育」").fill(opts.团队);
  await page.getByPlaceholder("你的姓名").fill(opts.姓名);
  await page.getByPlaceholder("手机号或邮箱").fill(opts.手机);
  // 激活码替代了验证码：setup 里预置了 5 个，每次注册用掉一个
  await page.getByPlaceholder(/激活码/).fill(下一个码());
  await page.getByPlaceholder("设置密码").fill(opts.密码);
  await page.getByRole("button", { name: "创建工作区" }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
}

/** 新建一个客户。销售负责人是必填项，要从下拉里挑一个 */
async function 建客户(page: Page, 姓名: string, 手机: string) {
  await page.goto("/customers");
  await page.getByRole("button", { name: /新建学员/ }).click();
  const 弹窗 = page.getByRole("dialog");
  await expect(弹窗).toBeVisible();
  await 弹窗.getByLabel("客户姓名").fill(姓名);
  await 弹窗.getByLabel("联系电话").fill(手机);
  await 弹窗.getByLabel("销售负责人").click();
  const 下拉 = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
  await 下拉.waitFor({ state: "visible" });
  await 下拉.locator(".ant-select-item-option").first().click();
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();
}

/**
 * 登录。每条用例跑在自己的浏览器上下文里，会话不共享，
 * 所以需要数据的用例各自登进来——顺带也把登录这条路每次都走一遍。
 */
async function 登录(page: Page, 手机: string, 密码: string) {
  await page.goto("/login");
  await page.getByPlaceholder("用户名").fill(手机);
  await page.getByPlaceholder("登录密码").fill(密码);
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
}

const 启明 = { 团队: "启明教育", 姓名: "林老师", 手机: "13800138000", 密码: "qiming2026" };
const 北辰 = { 团队: "北辰网络", 姓名: "赵经理", 手机: "13900139000", 密码: "beichen2026" };

test("1 注册就得到一个属于自己的空工作区", async ({ page }) => {
  await 注册(page, 启明);
  // 名字现在出现两处：侧栏的用户块 + 对话面的问候语（「下午好，林老师。」）。
  // 意图只是"落在了自己的工作区"，看到一处就够，别让第二处把严格模式撞挂
  await expect(page.getByText("林老师").first()).toBeVisible();

  await page.goto("/customers");
  // 全新工作区：一条业务数据都不该有
  await expect(page.locator(".ant-empty-description").first()).toBeVisible({ timeout: 15_000 });
});

test("2 建一条客户，自己看得到", async ({ page }) => {
  await 登录(page, 启明.手机, 启明.密码);
  await 建客户(page, "启明的客户甲", "13900001111");
  await expect(page.getByText("启明的客户甲")).toBeVisible({ timeout: 15_000 });
});

test("3 另一个人注册进来，看不到上一家的客户", async ({ page }) => {
  await 注册(page, 北辰);

  await page.goto("/customers");
  await expect(page.getByText("赵经理")).toBeVisible();
  // 这是隔离的用户可见证明
  await expect(page.getByText("启明的客户甲")).toHaveCount(0);
});

test("4 试用到期后只读：横条出现，写操作被拒", async ({ page }) => {
  await 登录(page, 北辰.手机, 北辰.密码);
  拨到过期("北辰网络");
  // 租户解析按 token 缓存 10 秒，等它过期再看
  await page.waitForTimeout(11_000);

  await page.goto("/dashboard");
  await expect(page.getByText(/试用已结束/)).toBeVisible({ timeout: 15_000 });

  // 界面上拦不拦不重要，服务端必须拦住——Server Action 是公开端点
  await 建客户(page, "到期后不该写进去", "13900002222");
  await page.waitForTimeout(2000);
  // 不管界面怎么提示，这条数据绝不能真的进去
  await page.goto("/customers");
  await expect(page.getByText("到期后不该写进去")).toHaveCount(0);
});

test("5 开通页：说清怎么付，提交后等核对", async ({ page }) => {
  await 登录(page, 北辰.手机, 北辰.密码);
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
  // 运营台现在还有激活码表，里面「已用 · 北辰网络」也含这几个字，要精确匹配
  await expect(page.getByText("北辰网络", { exact: true })).toBeVisible();
  await expect(page.getByText(/待核对/).first()).toBeVisible();

  // 给北辰开通
  // antd 给两字按钮加了字间距，文本实际是「开 通」，所以用正则
  const 行 = page.getByRole("row").filter({ hasText: "北辰网络" });
  await 行.getByRole("button", { name: /开\s*通/ }).click();
  await page.getByRole("button", { name: /确\s*定|OK/ }).click();
  await expect(page.getByText(/已更新/)).toBeVisible({ timeout: 15_000 });

  await page.waitForTimeout(11_000);
  await 登录(page, 北辰.手机, 北辰.密码);
  await page.goto("/customers");
  // 开通之后横条消失，又能写了
  await expect(page.getByText(/试用已结束/)).toHaveCount(0);
  await 建客户(page, "开通后的客户", "13900003333");
  await expect(page.getByText("开通后的客户")).toBeVisible({ timeout: 15_000 });
});

test("7 没登录时注册与登录页可达，其余弹回登录", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByRole("button", { name: "创建工作区" })).toBeVisible();

  await page.goto("/customers");
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
});

test("8 没配 DEMO_WORKSPACE 时 /demo 不存在，而不是被中间件弹回登录", async ({ page }) => {
  /**
   * 这条钉的是中间件的公开名单。/demo 的职责是给没有会话的人签一张会话，
   * 一旦它没被列进公开名单，就会在执行之前先被弹回 /login——
   * 表现是官网点「在线试用」什么也没发生。曾经真这样过。
   *
   * 这套 e2e 不配 DEMO_WORKSPACE，所以正确答案是 404（路由自己拒绝），
   * 而不是 307 到 /login（中间件拦下）。两者都「打不开」，但原因完全不同。
   */
  const r = await page.request.get("/demo", { maxRedirects: 0 });
  expect(r.status(), "应当由路由自己返回 404，而不是被中间件重定向").toBe(404);
});

test("9 试用工作区的 AI 只有 5 次，第 6 次被拦、计数归零", async ({ page }) => {
  /**
   * 这套 e2e 不配 LLM_API_KEY，所以每次提问都会在模型那一步报「AI 功能未启用」——
   * 但额度是在发起调用**之前**扣的（失败也算，否则反复失败可以无限重试），
   * 所以不用真模型也能验闸门：问 5 次各扣一次，第 6 次拿到的是额度错误而不是模型错误。
   */
  await 注册(page, { 团队: "限额测试", 姓名: "赵老师", 手机: "13800138009", 密码: "Passw0rd99" });
  const 输入 = page.getByPlaceholder(/问一位/);
  await expect(page.locator(".cli-quota")).toHaveText("免费提问 5/5");

  for (let i = 1; i <= 5; i++) {
    await 输入.fill(`第 ${i} 问`);
    await page.locator(".cli-send").click();
    // 等这一轮结束（成功或失败都会让输入框恢复）
    await expect(输入).not.toHaveAttribute("placeholder", /正在回答/, { timeout: 30_000 });
  }
  await page.reload();
  await expect(page.locator(".cli-quota")).toHaveText("免费提问 0/5");

  await 输入.fill("第 6 问");
  await page.locator(".cli-send").click();
  await expect(page.locator(".cli-turn").last()).toContainText("已经用完", { timeout: 30_000 });
});
