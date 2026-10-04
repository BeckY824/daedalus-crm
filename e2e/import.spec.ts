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
import { test, expect, type Page, type Route } from "@playwright/test";
import { 装个假模型, 拆掉假模型 } from "./fake-llm";
import { 连库 } from "./mock-data";
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

/*
  T-024（2026-10-04 工作室试用前）：老板导入的客户全记在老板名下（规则，不改），业务员一个都看不到，以为导入失败。
  完成页说一句「都记在你名下，要分给业务员就去客户列表勾选后批量分配」；点「完成」落到这一批，勾选、批量分配那条路是通的
*/
test("T-024 导完：完成页指路「批量分配给业务员」；点完成落到这一批，全选后「批量分配」就在那儿", async ({ page }) => {
  await 登录(page);
  const 抽屉 = await 打开抽屉并选文件(page, "分给业务员.csv", ["姓名,手机号", `待分配${戳},139${戳}24`].join("\n"), "text/csv");
  await 过对列和复核(抽屉);
  await 抽屉.getByRole("button", { name: "开始导入" }).click();
  await expect(抽屉.getByText("导完了")).toBeVisible({ timeout: 30_000 });
  await expect(抽屉).toContainText("都记在你名下");
  await expect(抽屉).toContainText("批量分配");
  await 抽屉.getByRole("button", { name: /完\s*成/ }).click();
  await page.waitForURL(/batch=/);
  await expect(page.getByRole("link", { name: `待分配${戳}` })).toBeVisible();
  await page.locator(".ant-table-thead .ant-checkbox-input").check();
  await expect(page.getByRole("button", { name: /批量分配/ })).toBeVisible();
  // 收拾：这一位删掉，别留给别的用例
  const p = 连库();
  try {
    await p.customer.deleteMany({ where: { name: `待分配${戳}` } });
  } finally {
    await p.$disconnect();
  }
});

/*
  2026-10-04 J-049：第 4 步改选「只补空」原来不重算预览——「补空 0」、表里的人全在库里时「开始导入」一直是灰的，
  导入整条路走不通。重算函数有单测（import-disposition），这里钉界面：切过去数字跟着变、按钮能点、真的补上了
*/
/** 第 2 步「下一步」要等预览算完（按钮在转圈时点不动），等复核那一屏出来再点第 3 步的「下一步」 */
async function 过对列和复核(抽屉: ReturnType<Page["locator"]>) {
  await expect(抽屉.getByText(/读到了/)).toBeVisible();
  await 抽屉.getByRole("button", { name: "下一步" }).click();
  await expect(抽屉.getByText("每一格都读得懂，没有要你确认的")).toBeVisible({ timeout: 30_000 });
  await 抽屉.getByRole("button", { name: "下一步" }).click();
}

test("L-076 网页端的抽屉说实情：不写「文件不上传」；没接判断模型时第 1 步没有「让 AI 认一下」", async ({ page }) => {
  await 登录(page);
  const 抽屉 = await 打开抽屉(page);
  await expect(抽屉.getByText(/表格内容会传到服务器/)).toBeVisible();
  await expect(抽屉.getByText(/不上传/)).toHaveCount(0);
  await 抽屉.locator('input[type="file"]').setInputFiles({
    name: "怪列.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`姓名,手机号,备用栏\n怪列甲${戳},137${戳}01,展会`),
  });
  await expect(抽屉.getByText(/读到了/)).toBeVisible();
  await expect(抽屉.getByText(/有 1 列没有对应的字段/)).toBeVisible();
  await expect(抽屉.getByRole("button", { name: /让 AI 认一下/ })).toHaveCount(0);
});

test("J-058 表头上面有标题行、中间有空行：复核里报的「第 N 行」就是 Excel 里那一行", async ({ page }) => {
  await 登录(page);
  const csv = [
    "2026 年 9 月客户名单", // 第 1 行
    "姓名,手机号,公司", // 第 2 行
    `行号甲${戳},139${戳}01,远山资本`, // 第 3 行
    "", // 第 4 行空着
    `,139${戳}02,无名氏`, // 第 5 行
  ].join("\n");
  const 抽屉 = await 打开抽屉并选文件(page, "带标题.csv", csv, "text/csv");
  await 抽屉.getByRole("button", { name: "下一步" }).click();
  await expect(抽屉.getByText(/第 5 行：这一行没有姓名/)).toBeVisible();
});

test("库里已有的号再导一次：第 4 步改选「只补空」→「补空字段」变成 1、开始导入能点，导完补空 1 条", async ({ page }) => {
  await 登录(page);
  const 号 = `139${戳}11`;
  // 先导一位进库
  let 抽屉 = await 打开抽屉并选文件(page, "先有一位.csv", `姓名,手机号\n补空甲${戳},${号}`, "text/csv");
  await 过对列和复核(抽屉);
  await 抽屉.getByRole("button", { name: "开始导入" }).click();
  await expect(抽屉.getByText(/新建 1 条/)).toBeVisible({ timeout: 30_000 });

  // 同一个号带着公司再导一次
  抽屉 = await 打开抽屉并选文件(page, "再导一次.csv", `姓名,手机号,公司\n补空甲${戳},${号},远山资本`, "text/csv");
  await 过对列和复核(抽屉);
  const 开始 = 抽屉.getByRole("button", { name: "开始导入" });
  // 默认「跳过」：新建 0、跳过 1，没东西可导，按钮是灰的（这本身是对的）
  await expect(抽屉.getByText("跳过（已有）", { exact: true }).locator("..")).toHaveText("1跳过（已有）");
  await expect(开始).toBeDisabled();

  await 抽屉.getByText("只补空着的字段").click();
  await expect(抽屉.getByText("补空字段", { exact: true }).locator("..")).toHaveText("1补空字段");
  await expect(开始).toBeEnabled();
  await 开始.click();
  await expect(抽屉.getByText(/新建 0 条，补空 1 条/)).toBeVisible({ timeout: 30_000 });
});

/*
  2026-10-04 上线前第 1 期：导入完成页「撤销这一批」一次删好几位，原来一点就删（审查 M15）。
  现在先问，问话里写清会删几条；点「不了」库里一位不少
*/
test("完成页「撤销这一批」：先问、写清会删几条；点「不了」不删，确认才删", async ({ page }) => {
  await 登录(page);
  const 名 = `撤批甲${戳}`;
  const 抽屉 = await 打开抽屉并选文件(page, "撤这一批.csv", `姓名,手机号\n${名},137${戳}21`, "text/csv");
  await 过对列和复核(抽屉);
  await 抽屉.getByRole("button", { name: "开始导入" }).click();
  await expect(抽屉.getByText(/新建 1 条/)).toBeVisible({ timeout: 30_000 });

  const 撤 = 抽屉.getByRole("button", { name: "撤销这一批" });
  const 问 = page.locator(".ant-popconfirm", { hasText: "撤销这一批导入？" });
  await 撤.click();
  await expect(问).toBeVisible();
  // e528bf0（第 2 期 2a）起用工作区叫法：「新建的 1 位客户」，原来是「1 条新建的记录」
  await expect(问).toContainText("会删掉这一批新建的 1 位客户");
  // 问的时候人还在库里
  await 问.getByRole("button", { name: /不\s*了/ }).click();
  await expect(问).toBeHidden();
  await page.waitForTimeout(500);
  const 库 = 连库();
  try {
    expect(await 库.customer.count({ where: { name: 名 } }), "点了「不了」却删了").toBe(1);
    await 撤.click();
    await 问.getByRole("button", { name: /撤\s*销/ }).click();
    await expect(page.getByRole("dialog", { name: "已撤销这一批" })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => 库.customer.count({ where: { name: 名 } })).toBe(0);
  } finally {
    await 库.$disconnect();
  }
});

/*
  J-062：「已在库里的行怎么办」两个单选，原来给 Radio 设 display:block，圆点和字拆成两行、说明冲出抽屉（7699783）。
  量盒子：圆点在字的左边、和字落在同一段高度里（不是自己单独一行），整个选项不超出抽屉
*/
async function 到第4步有重复(page: Page, 标: string) {
  const 号 = `139${戳}${标}`;
  let 抽屉 = await 打开抽屉并选文件(page, `对齐${标}甲.csv`, `姓名,手机号\n对齐${标}${戳},${号}`, "text/csv");
  await 过对列和复核(抽屉);
  await 抽屉.getByRole("button", { name: "开始导入" }).click();
  await expect(抽屉.getByText(/新建 1 条/)).toBeVisible({ timeout: 30_000 });
  抽屉 = await 打开抽屉并选文件(page, `对齐${标}乙.csv`, `姓名,手机号\n对齐${标}${戳},${号}`, "text/csv");
  await 过对列和复核(抽屉);
  const 选项 = 抽屉.locator(".ant-radio-wrapper");
  await expect(选项).toHaveCount(2);
  return { 抽屉, 选项 };
}

test("J-062 第 4 步两个单选：圆点和字在同一段里、圆点在左，不冲出抽屉", async ({ page }) => {
  await 登录(page);
  const { 抽屉, 选项 } = await 到第4步有重复(page, "31");
  const 抽屉盒 = (await 抽屉.locator(".ant-drawer-body").boundingBox({ timeout: 5_000 }))!;
  for (let i = 0; i < 2; i++) {
    const 圆 = (await 选项.nth(i).locator(".ant-radio").boundingBox())!;
    const 字 = (await 选项.nth(i).locator("> span").last().boundingBox())!;
    const 整个 = (await 选项.nth(i).boundingBox())!;
    expect(圆.y + 圆.height > 字.y && 圆.y < 字.y + 字.height, `第 ${i + 1} 个选项圆点和字拆成了两行`).toBe(true);
    expect(圆.x + 圆.width, `第 ${i + 1} 个选项圆点不在字左边`).toBeLessThanOrEqual(字.x + 1);
    expect(整个.x + 整个.width, `第 ${i + 1} 个选项冲出抽屉`).toBeLessThanOrEqual(抽屉盒.x + 抽屉盒.width + 1);
  }
});

/*
  还剩一点：圆点按整段（标题 + 说明）垂直居中，说明折成两行的「只补空」那一项，圆点落在说明那一行旁边、不在粗体标题旁边。
  不伤数据，排下一版
*/
test.skip("【下一版】J-062 第 4 步两个单选：圆点对齐粗体标题那一行，不落到说明旁边", async ({ page }) => {
  await 登录(page);
  const { 选项 } = await 到第4步有重复(page, "32");
  for (let i = 0; i < 2; i++) {
    const 圆 = (await 选项.nth(i).locator(".ant-radio").boundingBox())!;
    const 标题 = (await 选项.nth(i).locator("b").boundingBox())!;
    expect(Math.abs(圆.y + 圆.height / 2 - (标题.y + 标题.height / 2)), `第 ${i + 1} 个选项圆点没对着标题`).toBeLessThan(4);
  }
});

/*
  J-061：导入抽屉的三个 server action 抛出来的失败原来没接住——按钮转一下又恢复，一声不吭。
  拦住「算预览」那一次请求回 500：要说一句、按钮恢复能点；放开之后再点就往下走
*/
test("J-061 算预览那一步服务端出错：说一句话、按钮恢复，放开后再点能往下走", async ({ page }) => {
  await 登录(page);
  const 抽屉 = await 打开抽屉并选文件(page, "出错.csv", `姓名,手机号\n出错甲${戳},137${戳}41`, "text/csv");
  await expect(抽屉.getByText(/读到了/)).toBeVisible();
  const 拦 = async (route: Route) => {
    const r = route.request();
    if (r.method() === "POST" && r.headers()["next-action"]) return route.fulfill({ status: 500, body: "boom" });
    return route.continue();
  };
  await page.route("**/customers**", 拦);
  const 下一步 = 抽屉.getByRole("button", { name: "下一步" });
  await 下一步.click();
  await expect(page.locator(".ant-message-error")).toBeVisible();
  await expect(下一步).toBeEnabled();
  await expect(抽屉.getByText("每一格都读得懂，没有要你确认的")).toBeHidden();
  await page.unroute("**/customers**", 拦);
  await 下一步.click();
  await expect(抽屉.getByText("每一格都读得懂，没有要你确认的")).toBeVisible({ timeout: 30_000 });
});

/*
  J-065：设置 → 导入记录读失败，原来显示成「还没有导入过」——人会以为导入记录丢了。
  拦住那次读取回 500：要写「没读出来」并给「再读一次」，不写「还没有导入过」
*/
test("J-065 导入记录读不出来：说没读出来、给「再读一次」，不说「还没有导入过」", async ({ page }) => {
  await 登录(page);
  let 拦着 = true;
  await page.route("**/settings**", (route) => {
    const r = route.request();
    if (拦着 && r.method() === "POST" && r.headers()["next-action"]) return route.fulfill({ status: 500, body: "boom" });
    return route.continue();
  });
  await page.goto("/settings?tab=imports");
  await expect(page.getByText("导入记录没读出来")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("还没有导入过")).toHaveCount(0);
  拦着 = false;
  await page.getByRole("button", { name: "再读一次" }).click();
  await expect(page.getByText("导入记录没读出来")).toBeHidden();
  // 前面几条用例导过：读回来是表里的批次
  await expect(page.locator(".ant-table-row").first()).toBeVisible();
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
    // 死端口，必失败。要的是「说了话」并且**还停在这一步**，而不是默默把人留在转圈的按钮前。
    // 这句话写在按钮旁边那一行（红字，留着不走），不是一条几秒就消失的提示
    await expect(抽屉.locator(".aiw-text-err")).toBeVisible({ timeout: 30_000 });
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
