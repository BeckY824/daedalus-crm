/**
 * 全局 AI 面板（AiDock，⌘J）。
 *
 * 这一组不调模型——默认 e2e 的 LLM_API_KEY 是空的。钉的是**壳的行为**，
 * 那才是这一版真正改动的东西：
 *   1. 它在该在的页面上在，不该在的地方不在（首页就是宽模式的同一块，两处同时画会打架）
 *   2. 导航稳定：开合面板时左栏一格不动——这是拍过板的规矩
 *   3. 上下文看得见、点得掉；换一页重新带上
 *   4. 收起时是窄边不是浮钮：浮钮会压住每个列表页右上角的主动作（第一版就是这么撞的）
 */
import { test, expect, type Page } from "@playwright/test";
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { 连库 } from "./mock-data";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };

/**
 * 面板只在配了 AI 时才渲染——没配就不该有这个入口，而不是点开一个说"先去配 AI"的空壳。
 * 默认 e2e 故意把 LLM_API_KEY 设成空（见 playwright.config.ts：记录页的 AI 面板打开即生成，
 * 有 key 的话每条用例都会真调一次模型）。所以这一组自己往库里写一条配置，
 * **baseUrl 指向一个死端口**：万一哪里真发了请求，立刻失败，绝不会打到真的中转站。
 * 跑完删掉，不留给后面的用例。
 */
const LLM设置 = "llm";
/**
 * 和 lib/settings.ts 的 encryptSecret 同一套（aes-256-gcm，密钥是 `setting-secret:<AUTH_SECRET>` 的 sha256）。
 * 不直接 import 那个模块：它是服务端模块，Playwright 这个进程里加载不起来。
 * AUTH_SECRET 必须和 playwright.config.ts 里 webServer 的那个一字不差，否则服务端解不出来、当作没配。
 */
function 加密(plain: string): string {
  const key = createHash("sha256").update(`setting-secret:e2e-only-secret-not-used-in-production-0123456789`).digest();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "enc:v1:" + Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
}

test.beforeAll(async () => {
  const db = 连库();
  const value = JSON.stringify({ baseUrl: "http://127.0.0.1:9/v1", model: "e2e-fake", apiKeyEnc: 加密("e2e-fake-key") });
  await db.setting.upsert({ where: { key: LLM设置 }, create: { key: LLM设置, value }, update: { value } });
  await db.$disconnect();
});
test.afterAll(async () => {
  const db = 连库();
  await db.setting.deleteMany({ where: { key: LLM设置 } });
  await db.$disconnect();
});

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

const 面板 = (p: Page) => p.locator("aside.dock");
const 窄边 = (p: Page) => p.locator(".dock-rail");
const 开键 = (p: Page) => p.getByRole("button", { name: /打开 AI 面板/ });

test.describe("全局 AI 面板", () => {
  test("首页不出现——那儿本来就是宽模式的同一块东西", async ({ page }) => {
    await 登录(page);
    await expect(窄边(page)).toHaveCount(0);
    await expect(面板(page)).toHaveCount(0);
  });

  test("其余页面有一条常驻窄边，点开是 380 的面板", async ({ page }) => {
    await 登录(page);
    await page.goto("/customers");
    await expect(窄边(page)).toBeVisible();
    await 开键(page).click();
    await expect(面板(page)).toBeVisible();
    expect(Math.round((await 面板(page).boundingBox())!.width)).toBe(380);
  });

  test("⌘J 开、Esc 关", async ({ page }) => {
    await 登录(page);
    await page.goto("/channels");
    await page.keyboard.press("ControlOrMeta+j");
    await expect(面板(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(面板(page)).toHaveCount(0);
    await expect(窄边(page)).toBeVisible();
  });

  test("导航稳定：开合面板时左栏一格不动", async ({ page }) => {
    await 登录(page);
    await page.goto("/customers");
    const 左栏 = page.locator("nav.rail");
    const 前 = (await 左栏.boundingBox())!;
    await 开键(page).click();
    await expect(面板(page)).toBeVisible();
    const 后 = (await 左栏.boundingBox())!;
    expect(后.x).toBe(前.x);
    expect(后.width).toBe(前.width);
  });

  test("收起时那条窄边不压住页面右上角的主动作", async ({ page }) => {
    /**
     * 第一版做成 position:fixed 的药丸，实地一看正好盖在「新建学员」上——
     * 每个列表页的主动作都在右上角，那正是浮钮要去的位置。
     */
    await 登录(page);
    await page.goto("/customers");
    const 主动作 = page.getByRole("button", { name: /新建/ }).first();
    await expect(主动作).toBeVisible();
    const a = (await 主动作.boundingBox())!;
    const b = (await 窄边(page).boundingBox())!;
    // 窄边整个在主动作右边，横向不重叠
    expect(b.x).toBeGreaterThanOrEqual(a.x + a.width);
  });

  test("上下文：写出来、点得掉、换一页重新带上", async ({ page }) => {
    await 登录(page);
    await page.goto("/customers?followStatus=" + encodeURIComponent("已签约"));
    await 开键(page).click();
    const 条 = page.locator(".dock-ctx");
    await expect(条).toBeVisible();
    await expect(条).toContainText("客户");
    await expect(条).toContainText("已签约");

    // 点掉
    await page.getByRole("button", { name: "不带这一页的上下文" }).click();
    await expect(条).toHaveCount(0);

    /*
      换一页：那是新的一页，不是他刚才拒绝的那个，上下文要重新带上。
      **走左栏点过去（客户端导航），不是 page.goto**——goto 是整页重载，
      面板状态本来就会重置，那样测的是重载不是换页。顺便钉住「切页不断流」：
      面板挂在壳上，换页时它不该被卸掉重来。
    */
    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "渠道" }).click();
    await expect(page).toHaveURL(/\/channels/);
    await expect(面板(page)).toBeVisible();
    await expect(page.locator(".dock-ctx")).toContainText("渠道");
  });

  test("面板开着时正文跟着收窄，不出横向滚动条", async ({ page }) => {
    await 登录(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/channels");
    await 开键(page).click();
    await expect(面板(page)).toBeVisible();
    const 溢出 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(溢出).toBeLessThanOrEqual(1);
    // antd 的 xl 断点看视口不看这一栏，所以壳要标出「面板开着」让样式表重映射
    await expect(page.locator(".shell.shell-dock-open")).toHaveCount(1);
  });
});
