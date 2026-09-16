import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { 共享工作区 } from "./hosted-setup";

/**
 * 托管版走查（2026-09-16 改版后）。
 *
 * 网页版只有**一个共享工作区**，一套固定账号密码，由我们发给要试用的团队。
 * 注册那条路只开云端账号——它是给桌面端用的（桌面端本地模式必须先登录云端账号，
 * 而注册只有网页这一条路，见 desktop/main.js 顶部）。
 *
 * 所以这套的重点从「隔离」换成了两条边界：
 *   1. 注册开不出工作区，注册完的人进不了网页版，但要被明确指路
 *   2. 共享工作区不会过期，而且它比自部署实例更保守——密码在多个团队手里，
 *      「管理员」等于「拿到过密码的任何人」
 *
 * 用例之间有先后依赖（先注册再验登录被挡），所以串行。
 */
const ROOT = path.resolve(__dirname, "..");
const CONTROL_DB = path.join(ROOT, "prisma/e2e-hosted/control.db");

function 查控制面(sql: string, ...args: string[]): string {
  return execFileSync("node", ["--experimental-sqlite", "-e", `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    const r = db.prepare(process.argv[2]).get(...process.argv.slice(3));
    process.stdout.write(r ? String(Object.values(r)[0]) : '');
    db.close();
  `, CONTROL_DB, sql, ...args], { encoding: "utf8" }).trim();
}

const 工作区数 = () => Number(查控制面("SELECT count(*) c FROM Workspace"));

/** 把共享工作区的 AI 用量直接写成某个数，省得真问几十次 */
function 写AI用量(calls: number) {
  execFileSync("node", ["--experimental-sqlite", "-e", `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    const w = db.prepare("SELECT id FROM Workspace WHERE slug = ?").get(process.argv[2]);
    db.prepare('INSERT INTO "AiUsage" ("workspaceId","calls") VALUES (?, ?) ON CONFLICT("workspaceId") DO UPDATE SET calls = excluded.calls').run(w.id, Number(process.argv[3]));
    db.close();
  `, CONTROL_DB, 共享工作区.slug, String(calls)], { stdio: "pipe" });
}

/** 从控制面库里把刚发的验证码取出来。没配通道时它只打进服务端日志，测试读库最省事 */
function 取验证码(target: string, purpose: string): string {
  return 查控制面('SELECT code FROM "VerifyCode" WHERE target = ? AND purpose = ? AND usedAt IS NULL ORDER BY createdAt DESC LIMIT 1', target, purpose);
}

/** 注册走两步：第一步只填邮箱，第二步填密码。默认配置不要验证码，所以第一步是「下一步」 */
async function 注册(page: Page, 邮箱: string, 密码: string) {
  await page.goto("/signup");
  await expect(page.getByPlaceholder("设置密码")).toBeHidden();
  await page.getByPlaceholder("邮箱").fill(邮箱);
  await page.getByRole("button", { name: /下一步|发送验证码/ }).click();
  await expect(page.getByPlaceholder("设置密码")).toBeVisible({ timeout: 15_000 });
  // 不再问团队名——注册开不出工作区了
  await expect(page.getByPlaceholder(/团队名称/)).toHaveCount(0);
  await page.getByPlaceholder("设置密码").fill(密码);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "开通账号" }).click();
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
  await expect(弹窗).toBeHidden();
}

async function 登录(page: Page, 账号: string, 密码: string) {
  await page.goto("/login");
  await page.getByPlaceholder("用户名").fill(账号);
  await page.getByPlaceholder("登录密码").fill(密码);
  await page.getByRole("button", { name: /登\s*录/ }).click();
}

/**
 * 进共享工作区，并**等到真的进去了**才返回。
 * 不等的话后面的 goto 会在会话生效前发出去，被中间件弹回 /login——
 * 而在登录页上断言「没有某个东西」全都会通过，那是假的绿。
 */
async function 进共享区(page: Page) {
  await 登录(page, 共享工作区.邮箱, 共享工作区.密码);
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
}

/** 桌面端用户：注册一个云端账号，他在网页版没有工作区 */
const 桌面用户 = { 邮箱: "desktop@example.com", 密码: "desktop2026" };

test.describe.configure({ mode: "serial" });

test("1 注册只开云端账号，开不出工作区", async ({ page }) => {
  const 前 = 工作区数();
  await 注册(page, 桌面用户.邮箱, 桌面用户.密码);

  // 落点是桌面端，不是网页版
  await expect(page.getByText("注册成功")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/回到.*桌面端/)).toBeVisible();
  await expect(page).not.toHaveURL(/\/dashboard/);

  // 网页版只有那一个共享工作区，注册不该再多出一个
  expect(工作区数(), "注册开出了工作区").toBe(前);
});

test("2 这个账号登录网页版会被挡下，而且要说清去哪", async ({ page }) => {
  await 登录(page, 桌面用户.邮箱, 桌面用户.密码);
  // 密码是对的，所以不能说「账号或密码不对」——那会让人以为自己记错了密码
  await expect(page.getByText(/这个账号用于桌面端/)).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/login/);
});

test("3 共享工作区：那一套固定账号密码能进，建的客户看得见", async ({ page }) => {
  await 进共享区(page);
  await 建客户(page, "共享区的学员甲", "13900001111");
  await expect(page.locator("main").getByText("共享区的学员甲").first()).toBeVisible({ timeout: 15_000 });
});

test("4 它不会过期：没有试用横条，写操作一直可用", async ({ page }) => {
  await 进共享区(page);
  // 试用期这个概念在网页版已经不存在，横条整条去掉了。
  // 钉的是横条特有的那几句，别用「试用」两个字——共享工作区自己就叫「试用工作区」
  await expect(page.getByText(/试用还剩|试用已结束|试用期的 AI/)).toHaveCount(0);
  // 到期只读那套机制还在，但这个工作区的到期日在 2099 年，所以照样写得进去
  await 建客户(page, "过不过期都建得出", "13900002222");
  await expect(page.locator("main").getByText("过不过期都建得出").first()).toBeVisible({ timeout: 15_000 });
});

test("5 共享工作区里不摆管理员那几栏——密码在多个团队手里", async ({ page }) => {
  await 进共享区(page);
  await page.goto("/settings");
  // 先确认真的进了设置页：在登录页上断言「没有 AI 接入」永远成立，那是假的绿
  await expect(page.getByText("设置管理").first()).toBeVisible({ timeout: 15_000 });
  /**
   * 这里的用户角色是 ADMIN（他得能展示管理员看到的东西），但那套密码发给了多个团队。
   * 设置页最贵的一个按钮是 AI 接入那栏的「测试连接」：它会拿平台的 Key 往调用方
   * 自己填的地址发一次请求。服务端已经不给过 requireAdmin，界面这边也不该摆。
   */
  await expect(page.getByText("AI 接入")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /测试连接/ })).toHaveCount(0);
});

test("6 共享工作区里手机号要打码", async ({ page }) => {
  await 进共享区(page);
  await page.goto("/customers");
  // 电话默认不在那六列里了（批 2），先从「列」里勾出来——顺带验一下勾了真的会出现
  await page.getByRole("button", { name: "列" }).click();
  const 列菜单 = page.locator(".ant-dropdown:not(.ant-dropdown-hidden)");
  await 列菜单.waitFor({ state: "visible" });
  await 列菜单.getByText("联系电话").click();
  await page.keyboard.press("Escape");
  // 数据多半是编的，但一串 11 位数字在截图和录屏里与真号无从分辨
  await expect(page.locator("main").getByText("139****1111").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("main").getByText("13900001111")).toHaveCount(0);
});

test("7 运营台要 token：不带、带错都是 404", async ({ page }) => {
  expect((await page.goto("/admin"))?.status()).toBe(404);
  expect((await page.goto("/admin?token=乱填的"))?.status()).toBe(404);
  await page.goto("/admin?token=e2e-admin-token");
  await expect(page.getByRole("heading", { name: "工作区" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(共享工作区.名称, { exact: true })).toBeVisible();
});

test("8 没登录时能打开的就是那几页；演示区已经不存在", async ({ page }) => {
  for (const 页 of ["/login", "/signup", "/forgot", "/terms", "/privacy"]) {
    await page.goto(页);
    await expect(page, `${页} 不该被弹回登录`).toHaveURL(new RegExp(页.replace("/", "\\/")));
  }
  // /demo 整套（免登录入口、演示数据、每晚重置）2026-09-16 删掉了。
  // 它现在和别的内页一样被中间件弹回登录页——轮不到 404，因为中间件先拦。
  // 「路由真的没了」由登录之后那一步证明。
  await page.goto("/demo");
  await expect(page, "/demo 不该还是个免登录入口").toHaveURL(/\/login/);
  // 其余的仍然弹回登录
  await page.goto("/customers");
  await expect(page).toHaveURL(/\/login/);
  // 登录之后再看：路由本身已经不存在
  await 进共享区(page);
  expect((await page.goto("/demo"))?.status(), "/demo 的路由该删干净了").toBe(404);
});

test("9 AI 免费次数用完会被拦", async ({ page }) => {
  await 进共享区(page);
  写AI用量(9999);
  await page.reload();
  await page.getByPlaceholder(/问一位学员/).fill("还剩多少次");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/次数|用完|额度/).first()).toBeVisible({ timeout: 30_000 });
});

test("10 条款页不用登录就能读，注册页有勾选", async ({ page }) => {
  await page.goto("/terms");
  await expect(page.getByRole("heading", { name: /用户协议/ })).toBeVisible();
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: /隐私政策/ })).toBeVisible();
  await page.goto("/signup");
  await page.getByPlaceholder("邮箱").fill("checkbox@example.com");
  await page.getByRole("button", { name: /下一步|发送验证码/ }).click();
  await expect(page.getByRole("checkbox")).toBeVisible({ timeout: 15_000 });
});

test("11 忘记密码：收码、设新密码，旧会话当场作废", async ({ page }) => {
  /**
   * 三件事要一起成立才算真的「找回」：码收得到、新密码能登、**旧的登录状态没了**。
   * 最后一条最容易漏——会话是一张签了 7 天的 JWT，服务端不存它也就删不掉它，
   * 只换密码的话，拿着旧 Cookie 的那个人还能再用一周：锁换了，门没换。
   *
   * 改的是共享工作区那套凭据（网页版只剩它一个账号），所以改完要改回去，
   * 不然后面的用例登不进来。
   */
  await 进共享区(page);

  // 已登录也能进找回页：密码泄露了想立刻换掉，弹回 /dashboard 就没路走了
  await page.goto("/forgot");
  await page.getByPlaceholder("注册时用的邮箱").fill(共享工作区.邮箱);
  await page.getByRole("button", { name: "发送验证码" }).click();
  await expect(page.getByPlaceholder("邮件里的 6 位验证码")).toBeVisible({ timeout: 15_000 });

  // 先试一个错的：错一次不该把这封码作废，也不该把密码改掉
  await page.getByPlaceholder("邮件里的 6 位验证码").fill("000000");
  await page.getByPlaceholder("设置新密码").fill("Newpass22");
  await page.getByRole("button", { name: "设置新密码" }).click();
  await expect(page.getByText("验证码不对")).toBeVisible({ timeout: 15_000 });

  const code = 取验证码(共享工作区.邮箱, "reset");
  expect(code).toHaveLength(6);
  await page.getByPlaceholder("邮件里的 6 位验证码").fill(code);
  await page.getByRole("button", { name: "设置新密码" }).click();
  await expect(page.getByText("密码已经改好了")).toBeVisible({ timeout: 15_000 });

  // 旧会话：Cookie 还在，但已经不认了
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });

  // 新密码能进
  await 登录(page, 共享工作区.邮箱, "Newpass22");
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });

  /**
   * 这里**故意不把密码改回去**：再发一次码会撞上 60 秒的重发冷却，
   * 干等一分钟不值得。代价是这条用例跑完，共享工作区的密码就是 Newpass22 了——
   * 所以它必须是最后一条要登录的用例。后面只剩第 12 条，它只看登录页上有没有那个链接。
   * 要在它后面加需要登录的用例，就得先把这里的密码问题解决掉。
   */
});

test("12 登录页把找回入口摆出来", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "忘记密码？" })).toHaveAttribute("href", "/forgot");
});
