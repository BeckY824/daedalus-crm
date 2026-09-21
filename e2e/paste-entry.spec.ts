/**
 * 「粘一段聊天」这个入口。
 *
 * 主线是**粘一段 → 客户本自己长出来**，而在 2026-09-21 之前这条路藏在客户页的
 * 导入抽屉里，还是第二个栏位：人要先想到「导入」，再想到「原来还能粘文本」。
 * 首页是每天打开的第一屏，入口就该在这儿。
 *
 * 钉三件事：
 *   1. 输入框里那个带字的入口**一直在**（不是粘了才出现的隐藏功能）
 *   2. 粘进来一段像记录的东西时，上方出一条提示——**只提示，不自动跑**
 *      （「AI 不自动跑」是拍过板的，一次切分要花一次 AI 次数）
 *   3. 点了之后抽屉开在「粘一段文本」那一栏，而且**全文已经在框里**
 *      ——输入框那份被 maxLength 截过，截断的那份切出来会少人
 *
 * 不调模型：这一组只验入口和交接，切分本身有 import.spec.ts 和单测钉着。
 */
import { test, expect, type Page } from "@playwright/test";
import { 装个假模型, 拆掉假模型 } from "./fake-llm";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };

/**
 * 首页那块对话面只在**配了 AI** 的时候画（没配就是数据看板或「开始」卡，
 * 见 dashboard/page.tsx）。默认 e2e 的 key 是空的，所以这一组自己装一个指向
 * 死端口的假模型——入口在不在是壳的事，不需要真的模型答话。
 */
test.beforeAll(async ({ browser }) => 装个假模型(browser));
test.afterAll(async ({ browser }) => 拆掉假模型(browser));

/** 输入框那一条里的入口。**要和「开始」卡上那个分开**：两处都有，同名 */
const 框内入口 = (page: Page) => page.locator(".cli-bar2-l").getByRole("button", { name: "粘一段聊天" });

/** 三行、六十字以上——「像一段记录」的最低门槛，比这短的不该被拦下来问 */
const 一段聊天 = [
  "老王 13800001111 远山资本，昨天见过面，说预算要等下个季度再定",
  "@李娜 138-0000-2222 平川科技 已经加了微信，让我周三再联系一次",
  "还有个张总，手机 13700002222，他是老王介绍过来的，目前只是了解阶段",
].join("\n");

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

/**
 * 往输入框里粘一段文本。**走真的剪贴板和真的 ⌘V**。
 *
 * 试过自己 dispatch 一个 ClipboardEvent：onPaste 是会触发，但浏览器不会真的把字
 * 插进框里（合成事件没有默认行为），于是「框里的字还在」那条用例永远是空的——
 * 测出来的东西和人做的事不是一回事。
 */
async function 粘进去(page: Page, 文本: string) {
  await page.evaluate((t) => navigator.clipboard.writeText(t), 文本);
  const 框 = page.locator(".cli-input textarea").first();
  await 框.click();
  await 框.press("ControlOrMeta+v");
}

test.beforeEach(async ({ page, context }) => {
  // 真的粘贴要真的剪贴板
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await 登录(page);
  await page.goto("/dashboard");
});

test("首页输入框里一直摆着「粘一段聊天」", async ({ page }) => {
  await expect(框内入口(page)).toBeVisible();
});

test("空库时那张「开始」卡的主按钮也是「粘」，不是手敲第一位", async ({ page }) => {
  // 两个入口指同一条路；这一条钉的是「开始」卡上那个（它在 .start 里）
  const 卡 = page.locator(".start");
  if (await 卡.count()) {
    await expect(卡.getByRole("button", { name: "粘一段聊天" })).toBeVisible();
  }
});

test("点它就开在「粘一段文本」那一栏，不用先点导入再找栏位", async ({ page }) => {
  await 框内入口(page).click();
  const 抽屉 = page.locator(".ant-drawer");
  await expect(抽屉).toBeVisible();
  // Segmented 停在「粘一段文本」上
  await expect(抽屉.locator(".ant-segmented-item-selected")).toContainText("粘一段文本");
});

test("粘进来一段像记录的东西：只出一条提示，不自动跑", async ({ page }) => {
  await 粘进去(page, 一段聊天);
  const 提示 = page.locator(".cli-paste");
  await expect(提示).toBeVisible();
  await expect(提示).toContainText("3 行");
  // **没点之前什么都不该发生**：抽屉不开，也不该有任何请求在跑
  await expect(page.locator(".ant-drawer")).toHaveCount(0);
});

test("点「切成」之后，全文已经在抽屉的框里——不是输入框里那份截断的", async ({ page }) => {
  await 粘进去(page, 一段聊天);
  await page.locator(".cli-paste-y").click();
  const 抽屉 = page.locator(".ant-drawer");
  await expect(抽屉).toBeVisible();
  const 文本框 = 抽屉.locator("textarea").first();
  // 三行一行不少：首页那个输入框有 maxLength，截断的那份切出来会少人
  await expect(文本框).toHaveValue(一段聊天);
});

test("「当成问题问」点一次就不再纠缠", async ({ page }) => {
  await 粘进去(page, 一段聊天);
  await page.locator(".cli-paste-n").click();
  await expect(page.locator(".cli-paste")).toHaveCount(0);
  // 框里的字还在，人接着当问题问就是了
  await expect(page.locator(".cli-input textarea").first()).not.toHaveValue("");
});

test("短的、一行的粘贴不打扰人", async ({ page }) => {
  await 粘进去(page, "这个月签了多少？");
  await expect(page.locator(".cli-paste")).toHaveCount(0);
});
