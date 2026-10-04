/**
 * 桌面端的门：壳带着一次性令牌自动登录；令牌不对、没登录云端账号的一律挡在门口。
 *
 * 文件名带序号：整套共用一个库、串行跑，这一组必须最先——「新库第一次进门先选模版」
 * 「升上来第一次进主界面弹更新记录」都只在库还是新的时候成立。
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, 云端账号, 进门地址, DESKTOP_TOKEN } from "./env";
import { 没登录云端时, 进门 } from "./helpers";

const 版本 = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;

test.describe.configure({ mode: "serial" });

test("新库带令牌进门：先选模版，选「通用销售」后进首页，弹一次「已更新到」这一版", async ({ page }) => {
  await page.goto(进门地址());
  // 新库（没选过模版、没业务数据）落在主界面外面的选模版页（app/start）
  await expect(page).toHaveURL(/\/start$/);
  await expect(page.getByRole("heading", { name: "你主要做哪一类生意？" })).toBeVisible();
  // J-226：选模版是独立的一屏，不套在主界面外壳里（原来左栏导航也画出来了）
  await expect(page.locator("nav.rail")).toHaveCount(0);
  await expect(page.locator("aside.dock")).toHaveCount(0);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.getByRole("button", { name: /用通用销售开始/ }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  // prepare.ts 把「看过的更新记录」记成了上一版：进主界面自己弹一次
  const 弹窗 = page.getByRole("dialog", { name: new RegExp(`已更新到 ${版本.replace(/\./g, "\\.")}`) });
  await expect(弹窗).toBeVisible();
  await 弹窗.getByRole("button", { name: /知\s*道\s*了/ }).click();
  await expect(弹窗).toBeHidden();

  // 点了「知道了」才算看过：再进一次不弹了，左栏那一行也不挂「新」
  await page.reload();
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500);
  await expect(page.getByRole("dialog", { name: /已更新到/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "更新记录", exact: true })).toBeVisible();
});

test("再次带令牌进门直达首页，左下角是云端账号的名字；更新记录随时翻得到", async ({ page }) => {
  await 进门(page);
  await expect(page).toHaveURL(/\/dashboard/);
  // 管理员的名字邮箱对成了云端账号（desktop/server-entry.js 同一条规则）
  await expect(page.getByRole("button", { name: `${云端账号.name}，账号菜单` })).toBeVisible();

  await page.getByRole("button", { name: "更新记录", exact: true }).click();
  const 全部 = page.getByRole("dialog", { name: `更新记录 · 现在是 ${版本}` });
  await expect(全部).toBeVisible();
  await expect(全部).toContainText(版本);
});

test("进门带 next：站内路径照去，站外 / 登录页这类一律回首页", async ({ page }) => {
  await page.goto(进门地址("/customers"));
  await expect(page).toHaveURL(/\/customers$/);
  // 协议相对地址 = 站外，不许借自动登录跳出去
  await page.goto(进门地址("//evil.example.com/x"));
  await expect(page).toHaveURL(/localhost:\d+\/dashboard$/);
  await page.goto(进门地址("/login"));
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("令牌不对、没带令牌都进不来：403，不签会话", async ({ page }) => {
  for (const 地址 of ["/api/desktop/session?t=not-the-token", "/api/desktop/session", `/api/desktop/session?t=${"x".repeat(34)}`]) {
    const r = await page.request.get(地址, { maxRedirects: 0 });
    expect(r.status(), 地址).toBe(403);
    // 一张会话票据都不许发
    expect(r.headers()["set-cookie"] ?? "", 地址).not.toContain("crm_session");
  }
  // 浏览器这边也确实没拿到 cookie
  expect((await page.context().cookies()).map((c) => c.name)).not.toContain("crm_session");
});

/*
  D-1（2026-10-04，搭这套 e2e 时发现）：原来 /login 对任何没登录的请求都 307 到 /api/desktop/session?t=<令牌>，
  令牌就写在跳转地址里——同机别的系统账户、DNS 重绑定过来的网页都能拿到会话。
  现在只有壳自己的窗口（带 x-desktop-token）才自动登录；Host 不是本机地址的一律拒
*/
test("不是壳的请求拿不到令牌：/login 不再把令牌写进跳转；冒充别的域名直接被拒", async ({ request }) => {
  const 门 = await request.get("/login", { maxRedirects: 0 });
  expect(门.headers()["location"] ?? "").not.toContain("t=");
  expect(await 门.text()).not.toContain(DESKTOP_TOKEN);
  const 带对头 = await request.get("/login", { maxRedirects: 0, headers: { "x-desktop-token": DESKTOP_TOKEN } });
  expect(带对头.status(), "壳自己的窗口照旧自动登录").toBe(307);
  const 重绑定 = await request.get("/login", { maxRedirects: 0, headers: { host: "attacker.example.com", "x-desktop-token": DESKTOP_TOKEN } });
  expect(重绑定.status()).toBe(421);
  const 会话 = await request.get(`/api/desktop/session?t=${DESKTOP_TOKEN}`, { maxRedirects: 0, headers: { host: "attacker.example.com" } });
  expect(会话.status()).toBe(404);
});

test("没登录云端账号：带着令牌也被挡在登录门（DesktopAuth），登录后放行", async ({ page }) => {
  await 没登录云端时(async () => {
    await page.goto(进门地址());
    await expect(page).toHaveURL(/\/login/);
    // 新的门：云端账号的「登录或注册」，邮箱一格起步（policy 由假云端回答：可注册、可找回、应用内注册）
    await expect(page.getByRole("heading", { name: "登录或注册" })).toBeVisible();
    await expect(page.getByPlaceholder("you@company.com")).toBeVisible();
    await expect(page.getByRole("button", { name: /继\s*续/ })).toBeVisible();
  });
  // 放回 .cloud.json = 重新登录过：再进门就到首页
  await 进门(page);
  await expect(page).toHaveURL(/\/dashboard/);
});

test("进来之后云端账号被吊销：业务会话跟着作废，回登录门并说明原因", async ({ page }) => {
  await 进门(page, "/customers");
  await expect(page).toHaveURL(/\/customers/);
  await 没登录云端时(async () => {
    // 会话 cookie 还活着，但本体没了：(app)/layout.tsx 经 logout 把人送回登录门，带上 reason=revoked
    await page.goto("/customers");
    await expect(page).toHaveURL(/\/login\?reason=revoked/);
    await expect(page.getByText("这台机器的云端登录已经失效")).toBeVisible();
  });
});
