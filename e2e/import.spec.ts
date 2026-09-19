/**
 * 从 Excel / CSV 导入，以及整批撤销。
 *
 * 在真浏览器里走完五步，因为这条链上有三段**只有在浏览器里才成立**的东西：
 * 文件是在客户端读的（不上传）、xlsx 解析器是按需加载的、
 * 而「复核」那一屏的值要原样跟着走到落库那一步。
 *
 * 钉的是四件事，都是导错了以后最难收拾的：
 *   1. 自动猜列要猜对常见表头，猜不到的留空不硬靠
 *   2. 一格读不懂只留空那一格，整行照进
 *   3. 预览上那几个数就是真正会发生的数（同号多行已经合过）
 *   4. 撤销真的把这一批删干净
 */
import { test, expect, type Page } from "@playwright/test";
import { 装个假模型, 拆掉假模型 } from "./fake-llm";
import { 粘贴字数上限 } from "../src/lib/import/paste";

const 管理员 = { 用户名: "admin", 密码: "admin123" };
const 戳 = String(Date.now()).slice(-6);

async function 登录(page: Page) {
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

/** 一份故意脏的名单：同号两行、一格日期读不懂、一行没姓名、一行手机号不是号码 */
const 名单 = [
  "姓名,手机号,公司,预计签约,备注,跟进状态",
  `导入甲${戳},138${戳}01,远山资本,2026-10-20,微信聊过两次,跟进中`,
  `导入乙${戳},138 ${戳} 02,平川科技,下周,转介绍来的,跟进中`,
  `导入甲${戳},138${戳}01,,,后补的一句,`,
  `,138${戳}09,无名氏,,,`,
  `导入丁${戳},不详,某公司,,,`,
].join("\n");

async function 打开抽屉(page: Page) {
  await page.goto("/customers");
  // 库空时空状态里还有一颗「从 Excel 导入」，两颗都叫「…导入」。
  // 页头那颗在 DOM 里排前面（图标让它的可读名字是「import 导入」，精确匹配对不上）
  await page.getByRole("button", { name: "导入" }).first().click();
  const 抽屉 = page.locator(".ant-drawer");
  await expect(抽屉.getByText("把 Excel 或 CSV 拖到这里")).toBeVisible();
  return 抽屉;
}

async function 打开抽屉并选文件(page: Page, name: string, 内容: string | Buffer, mime: string) {
  const 抽屉 = await 打开抽屉(page);
  // 拖拽区那个 input 是隐藏的，直接喂给它——和人点开文件选择器等价
  await 抽屉.locator('input[type="file"]').setInputFiles({ name, mimeType: mime, buffer: Buffer.from(内容) });
  return 抽屉;
}

/** 切到「粘一段文本」那条路 */
async function 去粘贴那条路(page: Page) {
  const 抽屉 = await 打开抽屉(page);
  await 抽屉.getByText("粘一段文本").click();
  return 抽屉;
}

test("CSV：猜列 → 复核 → 预览 → 落库 → 撤销，走完整条", async ({ page }) => {
  await 登录(page);
  const 抽屉 = await 打开抽屉并选文件(page, "名单.csv", 名单, "text/csv");

  // ---- 第二步：自动猜列 ----
  await expect(抽屉.getByText(/读到了/)).toBeVisible();
  // 「姓名」「手机号」两列要被自动认出来，不用人动手
  await expect(抽屉.getByRole("row", { name: /^姓名 .*姓名（必填）/ })).toBeVisible();
  await expect(抽屉.getByRole("row", { name: /^手机号 .*手机号（必填）/ })).toBeVisible();
  await 抽屉.getByRole("button", { name: "下一步" }).click();

  // ---- 第三步：复核。进不来的两行要说清是哪一行、为什么 ----
  await expect(抽屉.getByText("有 2 行进不来")).toBeVisible();
  await expect(抽屉.getByText(/第 5 行：这一行没有姓名/)).toBeVisible();
  await expect(抽屉.getByText(/第 6 行：手机号看不出是个号码/)).toBeVisible();
  // 「下周」读不懂：只留空那一格，不拦整行
  await expect(抽屉.getByText(/「下周」读不出是哪一天/)).toBeVisible();
  await 抽屉.getByRole("button", { name: "下一步" }).click();

  // ---- 第四步：预览。同号那两行已经合成一条，所以是 2 不是 3 ----
  await expect(抽屉.getByText(/和前面的行是同一个手机号/)).toBeVisible();
  await 抽屉.getByRole("button", { name: "开始导入" }).click();

  // ---- 第五步：结果 ----
  await expect(抽屉.getByText("导完了")).toBeVisible({ timeout: 30_000 });
  await expect(抽屉.getByText(/新建 2 条/)).toBeVisible();

  // 真的进库了，而且手机号里的空格被规整掉了
  await page.goto("/customers");
  await expect(page.getByRole("link", { name: `导入甲${戳}` })).toBeVisible();
  await expect(page.getByRole("link", { name: `导入乙${戳}` })).toBeVisible();
  // 没姓名那行和手机号不是号码那行都没进来
  await expect(page.getByRole("link", { name: `导入丁${戳}` })).toHaveCount(0);

  // ---- 撤销：设置页里那一批 ----
  await page.goto("/settings");
  await page.getByText("导入记录", { exact: true }).click();
  await expect(page.getByText("名单.csv")).toBeVisible();
  // antd 会在两个汉字的按钮里塞一个空格，所以是「撤 销」——和别处找「登 录」一样用正则
  await page.getByRole("button", { name: /撤\s*销/ }).first().click();
  // Popconfirm 里的那颗确认
  await page.getByRole("button", { name: /撤\s*销/ }).last().click();
  const 弹窗 = page.getByRole("dialog", { name: "已撤销这一批" });
  await expect(弹窗).toBeVisible({ timeout: 20_000 });
  await expect(弹窗.getByText(/删掉 2 条/)).toBeVisible();
  // 这一批标成已撤销，再撤一次的入口就没了
  await expect(page.getByText("已撤销", { exact: true })).toBeVisible();

  await page.goto("/customers");
  await expect(page.getByRole("link", { name: `导入甲${戳}` })).toHaveCount(0);
  await expect(page.getByRole("link", { name: `导入乙${戳}` })).toHaveCount(0);
});

test("手机号那一列不指出来就不让往下走", async ({ page }) => {
  await 登录(page);
  // 表头里没有任何像手机号的列，猜不到
  const 抽屉 = await 打开抽屉并选文件(page, "没号码.csv", "姓名,公司\n某人,某公司", "text/csv");
  await expect(抽屉.getByText(/读到了/)).toBeVisible();
  await expect(抽屉.getByText("手机号那一列必须指出来")).toBeVisible();
  await expect(抽屉.getByRole("button", { name: "先指出手机号那一列" })).toBeDisabled();
});

/**
 * 「粘一段文本」那条路。
 *
 * 这一组**不调模型**——默认 e2e 的 LLM_API_KEY 是空的，装的那个假模型指向一个死端口。
 * 钉的是模型之外的四件事，每一件都在模型答得再好时也照样会出错：
 *
 *   1. 没接模型时这条路只说明原因，不摆一颗按了会失败的按钮
 *   2. 粘进去不会自己跑——这一次调用花钱、占次数，得人按那颗按钮
 *   3. 打不通时要说话。server action 抛出来的失败不接住的话，界面一声不吭，
 *      人只会以为按钮坏了（文件那条路上踩过一次同样的坑）
 *   4. 超字数时按钮是灰的，而且说得出超了多少——灰在那儿让人猜是最糟的
 */
test("没接模型时，「粘一段文本」只说明原因，不给按钮", async ({ page }) => {
  await 登录(page);
  const 抽屉 = await 去粘贴那条路(page);
  await expect(抽屉.getByText("这条路要先接上模型")).toBeVisible();
  // 「从文件那条路一样能用」这句必须在：这时候人要的是一条还能走的路，不是一句抱歉
  await expect(抽屉.getByText(/一样能用/)).toBeVisible();
  await expect(抽屉.getByRole("button", { name: /整理成表格/ })).toBeDisabled();
});

test.describe("粘一段文本（接上模型之后）", () => {
  test.beforeAll(async ({ browser }) => 装个假模型(browser));
  test.afterAll(async ({ browser }) => 拆掉假模型(browser));

  test("粘进去不会自己跑；按了按钮而模型打不通时要说话，不能一声不吭", async ({ page }) => {
    await 登录(page);
    const 抽屉 = await 去粘贴那条路(page);
    const 按钮 = 抽屉.getByRole("button", { name: /整理成表格/ });
    await expect(按钮).toBeDisabled(); // 什么都没粘

    await 抽屉.locator("textarea").fill(`王强 138${戳}01 远山资本，下周三再聊`);
    await expect(按钮).toBeEnabled();
    // 粘完等一会儿：这一步没有按按钮，就不该有任何事发生
    await page.waitForTimeout(1500);
    await expect(抽屉.getByText(/读到了/)).toHaveCount(0);

    await 按钮.click();
    // 死端口，必失败。要的是「说了话」并且**还停在这一步**，而不是默默把人留在转圈的按钮前
    await expect(page.locator(".ant-message")).toBeVisible({ timeout: 30_000 });
    await expect(抽屉.getByText(/读到了/)).toHaveCount(0);
    await expect(按钮).toBeEnabled();
  });

  test("超了字数按钮就是灰的，而且说得出超了多少", async ({ page }) => {
    await 登录(page);
    const 抽屉 = await 去粘贴那条路(page);
    await 抽屉.locator("textarea").fill("人".repeat(粘贴字数上限 + 7));
    await expect(抽屉.getByText(/超了 7 字/)).toBeVisible();
    await expect(抽屉.getByRole("button", { name: /整理成表格/ })).toBeDisabled();
  });
});
