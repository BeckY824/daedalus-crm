/**
 * e2e 里装一个「配了 AI，但打不通」的模型，以及事后拆干净。
 *
 * 默认 e2e 的 LLM_API_KEY 是空的（见 playwright.config.ts），因为有 key 的话
 * 每条用例都会真调一次模型——慢、花钱、还让结果跟着模型的响应时间抖。
 * 但有几组用例钉的恰恰是**接上模型之后那个壳的行为**：入口在不在、按钮亮不亮、
 * 不按按钮会不会自己跑。那就得让服务端认为配过。
 *
 * **接口地址指向一个死端口**：万一哪里真发了请求，立刻失败，绝不会打到真的中转站。
 *
 * ## 为什么走界面，而不是直接往 Setting 表里写一行
 *
 * 因为直接写库**服务端看不见**。设置读取走一张进程内缓存（lib/settings.ts），
 * 只有应用自己调 `setSetting` 时才整体失效。Playwright 这个进程往库里写一行，
 * 跑着的那个 dev server 一无所知，于是用例测的是「没配 AI」那条分支——
 * 而它不会报错，只会安静地测另一件事。
 *
 * 原先 ai-dock 那一组正是直接写库的，一直绿，**靠的是它按字母序排第一**：
 * 那时缓存还没被任何请求填上。import 这一组排在中间，同样的写法就立刻露馅了。
 * 所以这里改成走人真正会走的那条路：登录、进设置、填上、保存。
 */
import { expect, type Browser, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";

/** 只有管理员能改 AI 接入 */
const 管理员 = { 用户名: "admin", 密码: "admin123" };

async function 登录管理员(page: Page) {
  await page.goto("/login");
  const 提示 = page.locator(".ant-alert");
  for (let i = 0; i < 3; i++) {
    await page.getByPlaceholder("用户名").fill(管理员.用户名);
    await page.getByPlaceholder("登录密码").fill(管理员.密码);
    await page.getByRole("button", { name: /登\s*录/ }).click();
    for (let t = 0; t < 40; t++) {
      if (/\/dashboard/.test(page.url())) return;
      if (await 提示.isVisible().catch(() => false)) throw new Error("登录失败");
      await page.waitForTimeout(200);
    }
  }
  throw new Error("登录没反应");
}

/**
 * 在设置页把 AI 接入填上。要求这一页已经是管理员登录着的。
 * 重复填一次是安全的：同一把假 Key 覆盖同一行设置。
 */
export async function 配好AI(page: Page) {
  await page.goto("/settings?tab=ai");
  // AI 接入 2026-09-17 起是「两个选择」：先说要用自己的 Key，再选「其它」才出现接口地址
  await page.getByRole("radio", { name: /用你自己的 API Key/ }).click();
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
}

/** 给 `test.beforeAll({ browser })` 用：自己开一页、自己登录、填完关掉 */
export async function 装个假模型(browser: Browser) {
  const page = await browser.newPage();
  try {
    await 登录管理员(page);
    await 配好AI(page);
  } finally {
    await page.close();
  }
}

/**
 * 拆干净。**必须也走界面**，理由和上面那条一样：
 * 只 `deleteMany` 的话库里是空的、而服务端缓存里那份还在，
 * 后面每一组用例都会以为 AI 开着，于是到处去打那个死端口。
 * 界面点不动时（比如这一组把设置页改坏了）再兜底删库，至少不把脏数据留给下一轮。
 */
export async function 拆掉假模型(browser: Browser) {
  const page = await browser.newPage();
  try {
    await 登录管理员(page);
    await page.goto("/settings?tab=ai");
    await page.getByRole("button", { name: "删掉这把 Key" }).click();
    await page.getByRole("button", { name: "删掉这把 Key" }).last().click();
    await expect(page.locator(".ant-message")).toContainText("已清除");
    /*
      **把重新渲染那一下自己吃掉。**

      存 / 清 AI 配置都会 `revalidatePath("/", "layout")`，整站的路由缓存一起失效。
      失效之后第一次打开列表页是一次完整的服务端渲染，明显慢一拍——
      而下一组用例（multiuser D 组）恰好是两个人同时「全选 → 批量状态 → 选一项」，
      慢的那一拍正好夹在勾选和点开下拉之间，选择被重新渲染冲掉，下拉再也不出现。

      这不是那一组用例的毛病，是我们在它前面动了全局缓存。谁弄脏谁擦干净：
      在这里先走一趟列表页，把那次渲染付掉，再把场子交出去。
    */
    await page.goto("/customers");
    await expect(page.locator(".ant-table").first()).toBeVisible();
  } finally {
    await page.close();
    const db = 连库();
    await db.setting.deleteMany({ where: { key: "llm" } });
    await db.$disconnect();
  }
}
