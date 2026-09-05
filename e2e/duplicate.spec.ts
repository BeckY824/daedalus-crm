/**
 * 各类「重复」的提示行为。
 *
 * 系统里的重复提示不是一套，而是强度不同的三档，这组用例把每一档都钉住：
 *   预警  —— 手机号失焦时的黄条，只提示、不拦（人可能就是要再录一笔）
 *   硬拦  —— 保存时服务端再查一次，直接拒绝（手机号、渠道名、成员邮箱）
 *   可越过 —— 签约同额同日，弹窗让人确认后仍可继续（续费/分期本来就长这样）
 *
 * 另有一处**目前没有任何校验**：成员姓名可以重名。最后一条用例把这个现状钉住，
 * 它会失败——失败是有意的信号，不是用例写错了。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库, 清空业务数据 } from "./mock-data";

const 销售 = { 用户名: "zhangsan", 密码: "crm@2026" };
const 管理员 = { 用户名: "admin", 密码: "crm@2026" };
const 戳 = String(Date.now()).slice(-6);
const 甲手机 = `139${戳}01`;
const 甲姓名 = `查重甲${戳}`;

async function 登录(page: Page, 账号: { 用户名: string; 密码: string }) {
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

/** antd 关掉的下拉仍留在 DOM 里，选项必须按 listbox 的 id 圈定 */
function 下拉选项(page: Page, listId: string) {
  return page
    .locator(".ant-select-dropdown")
    .filter({ has: page.locator(`#${listId}`) })
    .locator(".ant-select-item-option");
}

async function 填学员(page: Page, 姓名: string, 手机: string) {
  const 弹窗 = page.getByRole("dialog", { name: "新建学员" });
  await 弹窗.getByLabel("客户姓名").fill(姓名);
  await 弹窗.getByLabel("联系电话").fill(手机);
  await 弹窗.getByLabel("销售负责人").click();
  // 按名字选，不能取 first()：下拉是按姓名排序的，多一个账号顺序就变了
  await 下拉选项(page, "salesOwnerId_list").filter({ hasText: "张三" }).first().click();
  return 弹窗;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  /**
   * 本组会建出临时成员（重复登录名、重名的「张三」），清库的 helper 有意保留账号，
   * 所以这里额外收拾一次。不收拾的话重复跑时，多出来的账号会混进各处负责人下拉，
   * 让后面的用例选中不该选的人。
   */
  await p.user.deleteMany({ where: { email: { notIn: ["admin", "zhangsan", "lisi"] } } });
  await p.$disconnect();
});

test("先建一个学员，作为后面查重的靶子", async ({ page }) => {
  await 登录(page, 销售);
  await page.goto("/customers");
  await page.getByRole("button", { name: /新建学员/ }).click();
  const 弹窗 = await 填学员(page, 甲姓名, 甲手机);
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();
  await expect(弹窗).toBeHidden();
  await expect(page.getByRole("cell", { name: 甲姓名, exact: true })).toBeVisible();
});

test("手机号失焦就预警，且要说清楚撞的是谁——只报「重复」等于没说", async ({ page }) => {
  await 登录(page, 销售);
  await page.goto("/customers");
  await page.getByRole("button", { name: /新建学员/ }).click();
  const 弹窗 = page.getByRole("dialog", { name: "新建学员" });

  await 弹窗.getByLabel("联系电话").fill(甲手机);
  await 弹窗.getByLabel("客户姓名").click(); // 失焦

  const 黄条 = 弹窗.locator(".ant-alert-warning");
  await expect(黄条).toBeVisible();
  await expect(黄条).toContainText("系统中已有这条线索");
  // 光说撞了没用，得让人认出是哪一条：姓名和负责人都要在
  await expect(黄条).toContainText(甲姓名);
  await expect(黄条).toContainText("张三");
});

test("预警只是预警，不能把人拦在这一步——填完仍然可以继续操作", async ({ page }) => {
  await 登录(page, 销售);
  await page.goto("/customers");
  await page.getByRole("button", { name: /新建学员/ }).click();
  const 弹窗 = await 填学员(page, `换个名${戳}`, 甲手机);
  await expect(弹窗.locator(".ant-alert-warning")).toBeVisible();
  // 保存按钮不该被禁用：拦截的活儿交给服务端，前端不替人做决定
  await expect(弹窗.getByRole("button", { name: /保\s*存/ })).toBeEnabled();
});

test("保存时服务端硬拦，且弹窗留在原地不能关——关了等于白填一遍", async ({ page }) => {
  await 登录(page, 销售);
  await page.goto("/customers");
  await page.getByRole("button", { name: /新建学员/ }).click();
  const 弹窗 = await 填学员(page, `重复录入${戳}`, 甲手机);
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();

  await expect(page.getByText(`手机号 ${甲手机} 已存在`)).toBeVisible();
  await expect(page.getByText(甲姓名).first()).toBeVisible(); // 提示里要带上撞的是谁
  await expect(弹窗).toBeVisible();
});

test("编辑自己时不该把自己当成重复", async ({ page }) => {
  await 登录(page, 销售);
  await page.goto("/customers");
  await page.getByRole("button", { name: `编辑 ${甲姓名}` }).click();

  const 弹窗 = page.getByRole("dialog", { name: "编辑学员" });
  await 弹窗.getByLabel("联系电话").click();
  await 弹窗.getByLabel("客户姓名").click(); // 原样失焦
  await expect(弹窗.locator(".ant-alert-warning")).toBeHidden();

  // 原样保存也要能存下去
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();
  await expect(弹窗).toBeHidden();
});

test("没有重名时，下拉不该给任何人加登录名后缀", async ({ page }) => {
  await 登录(page, 销售);
  await page.goto("/customers");
  await page.getByRole("button", { name: /新建学员/ }).click();
  await page.getByRole("dialog", { name: "新建学员" }).getByLabel("销售负责人").click();
  await expect(下拉选项(page, "salesOwnerId_list").filter({ hasText: "（" })).toHaveCount(0);
});

test("成员登录名重复要硬拦", async ({ page }) => {
  await 登录(page, 管理员);
  await page.goto("/settings");

  const 登录名 = `dup${戳}`;
  for (const 姓名 of [`占位${戳}`, `撞名${戳}`]) {
    await page.getByRole("button", { name: /新增成员/ }).click();
    const 弹窗 = page.getByRole("dialog");
    await 弹窗.getByLabel("姓名").fill(姓名);
    await 弹窗.getByLabel("登录用户名").fill(登录名);
    await 弹窗.getByLabel("初始密码").fill("crm@2026");
    await 弹窗.getByRole("button", { name: /保\s*存/ }).click();

    if (姓名.startsWith("占位")) {
      await expect(弹窗).toBeHidden();
    } else {
      // 第二次必须被拦，且弹窗留在原地——关掉等于白填
      await expect(page.getByText("该登录用户名已被占用")).toBeVisible();
      await expect(弹窗).toBeVisible();
      await 弹窗.getByRole("button", { name: /取\s*消/ }).click();
    }
  }
});

/** 登录名就是登录页填的那个，必须能建成 lisi 这种格式——曾经被 email 校验挡死 */
test("新增成员能用用户名做登录名，与既有账号和登录页保持一致", async ({ page }) => {
  await 登录(page, 管理员);
  await page.goto("/settings");
  await page.getByRole("button", { name: /新增成员/ }).click();

  const 弹窗 = page.getByRole("dialog");
  await 弹窗.getByLabel("姓名").fill(`用户名账号${戳}`);
  await 弹窗.getByLabel("登录用户名").fill(`lisi${戳}`); // 和 zhangsan 一个格式
  await 弹窗.getByLabel("初始密码").fill("crm@2026");
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();

  await expect(弹窗).toBeHidden();
});

/**
 * 同名不硬拦、但要确认一次：同名同事是正常情况，拦下来管理员就建不了人；
 * 不提示则会把「张三」错建成第二条而不自知。确认后建成，负责人下拉自动带登录名区分。
 */
test("成员姓名重名会先确认，确认后建成且下拉能区分", async ({ page }) => {
  await 登录(page, 管理员);
  await page.goto("/settings");
  await page.getByRole("button", { name: /新增成员/ }).click();

  const 弹窗 = page.getByRole("dialog", { name: "新增成员" });
  await 弹窗.getByLabel("姓名").fill("张三"); // 与既有成员同名
  await 弹窗.getByLabel("登录用户名").fill(`zs2${戳}`);
  await 弹窗.getByLabel("初始密码").fill("crm@2026");
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();

  // 先确认：要说清楚撞的是谁，只说「重名」等于没说
  const 确认框 = page.getByRole("dialog", { name: "已有同名成员" });
  await expect(确认框).toBeVisible();
  await expect(确认框).toContainText("zhangsan");
  await 确认框.getByRole("button", { name: /确实是另一个人/ }).click();
  await expect(弹窗).toBeHidden();

  // 建成之后，负责人下拉必须能把两个「张三」分开
  await page.goto("/customers");
  await page.getByRole("button", { name: /新建学员/ }).click();
  await page.getByRole("dialog", { name: "新建学员" }).getByLabel("销售负责人").click();
  const 选项 = 下拉选项(page, "salesOwnerId_list");
  await expect(选项.filter({ hasText: "张三（zhangsan）" })).toHaveCount(1);
  await expect(选项.filter({ hasText: `张三（zs2${戳}）` })).toHaveCount(1);
  // 没撞名的人不该被加噪音
  await expect(选项.filter({ hasText: /^李四$/ })).toHaveCount(1);
});

test("登录用户名的格式错了要当场拦住，别等提交", async ({ page }) => {
  await 登录(page, 管理员);
  await page.goto("/settings");
  await page.getByRole("button", { name: /新增成员/ }).click();

  const 弹窗 = page.getByRole("dialog", { name: "新增成员" });
  await 弹窗.getByLabel("姓名").fill(`格式错${戳}`);
  await 弹窗.getByLabel("登录用户名").fill("a b@!");
  await 弹窗.getByLabel("初始密码").fill("crm@2026");
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();

  await expect(弹窗.getByText(/只能用小写字母、数字/)).toBeVisible();
  await expect(弹窗).toBeVisible();
});

test("填了大写的登录名要归一成小写，否则会出现「填的名字登不进去」", async ({ page }) => {
  await 登录(page, 管理员);
  await page.goto("/settings");
  await page.getByRole("button", { name: /新增成员/ }).click();

  const 弹窗 = page.getByRole("dialog", { name: "新增成员" });
  await 弹窗.getByLabel("姓名").fill(`大写${戳}`);
  await 弹窗.getByLabel("登录用户名").fill(`DaXie${戳}`); // 故意用大写
  await 弹窗.getByLabel("初始密码").fill("crm@2026");
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();
  await expect(弹窗).toBeHidden();

  // 列表里存下来的必须already是小写——登录时是按小写比对的
  await expect(page.getByRole("cell", { name: `daxie${戳}`, exact: true })).toBeVisible();
});

/**
 * 报表回归锁。
 *
 * 聚合一旦按姓名分组，两个同名销售的签约会累加进同一行——报表读数直接错，
 * 而且没有任何迹象，不会有人来报这个错。这类「静默 + 涉钱」的缺陷必须有用例守住。
 * 依赖上一条用例建出的第二个「张三」。
 */
test("报表按 id 聚合：两个同名销售的业绩不能合并成一行", async ({ page }) => {
  const p = 连库();
  const 两个张三 = await p.user.findMany({ where: { name: "张三" }, select: { id: true, email: true } });
  expect(两个张三, "前一条用例应当已经建出第二个「张三」").toHaveLength(2);

  // 各给一笔金额不同的签约，合并与否一眼可辨
  for (const [i, u] of 两个张三.entries()) {
    const c = await p.customer.create({
      data: {
        name: `报表学员${i}${戳}`,
        phone: `138${戳}0${i}`,
        followStatus: "已签约",
        decisionStatus: "已决定报名",
        salesOwnerId: u.id,
      },
    });
    await p.contract.create({
      data: { customerId: c.id, amount: (i + 1) * 10000, signedAt: new Date(2026, 5, 10) },
    });
  }
  await p.$disconnect();

  await 登录(page, 管理员);
  await page.goto("/reports?year=2026&period=month");

  const 表 = page.locator(".ant-table").filter({ hasText: "销售负责人" }).first();
  const 行 = 表.locator(".ant-table-row").filter({ hasText: "张三" });
  await expect(行, "两个张三必须各占一行").toHaveCount(2);

  // 金额必须各归各的；合并的话会出现 ¥ 30,000
  await expect(表).toContainText("¥ 10,000");
  await expect(表).toContainText("¥ 20,000");
  await expect(表, "两人业绩被合并成了一行").not.toContainText("¥ 30,000");

  // 两行还要能分辨出谁是谁
  await expect(行.filter({ hasText: "（zhangsan）" })).toHaveCount(1);
});

/**
 * 管理员不该出现在任何业务负责人下拉里——他只做系统加工与维护。
 *
 * 这条锁的是**口径一致**：业绩排行榜一开始就排除了管理员，
 * 而各处负责人下拉一直把他列着，同一个系统里两套说法。
 * 走查时发现的，不是实现错误，是当初没定过的规矩。
 */
test("负责人下拉不列管理员，与业绩排行榜口径一致", async ({ page }) => {
  await 登录(page, 销售);

  // 学员的销售负责人
  await page.goto("/customers");
  await page.getByRole("button", { name: /新建学员/ }).click();
  await page.getByRole("dialog", { name: "新建学员" }).getByLabel("销售负责人").click();
  const 销售候选 = 下拉选项(page, "salesOwnerId_list");
  await expect(销售候选.filter({ hasText: "管理员" }), "管理员不该能被选为销售负责人").toHaveCount(0);
  // 顺带确认没把正常销售一起筛掉。用张三而不是李四：
  // multiuser 的 E 组会停用李四且不恢复，用他等于隐性依赖文件执行顺序
  await expect(销售候选.filter({ hasText: "张三" }).first()).toBeVisible();
  await page.keyboard.press("Escape");

  // 渠道负责人走的是同一份候选
  await page.goto("/channels");
  await page.getByRole("button", { name: /新建渠道|新增渠道/ }).click();
  const 渠道弹窗 = page.getByRole("dialog");
  await 渠道弹窗.getByLabel("渠道负责人").click();
  await expect(
    page.locator(".ant-select-dropdown").locator(".ant-select-item-option").filter({ hasText: "管理员" }),
    "管理员不该能被选为渠道负责人",
  ).toHaveCount(0);
});
