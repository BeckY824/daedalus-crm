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

/**
 * 新建一个客户。
 *
 * 「销售负责人」**只在工作区里不止一个人时才出现**（2026-09-18）：
 * 刚开出来的工作区只有开号那一个人，让他从一个只有自己的下拉里选一次自己，
 * 是在问一个只有一个答案的问题，所以那一项整个不画，保存时由服务端填。
 * 这个 helper 两种情况都要能用——托管版的用例里两种工作区都有。
 */
async function 建客户(page: Page, 姓名: string, 手机: string) {
  await page.goto("/customers");
  await page.getByRole("button", { name: /新建客户/ }).click();
  const 弹窗 = page.getByRole("dialog");
  await expect(弹窗).toBeVisible();
  await 弹窗.getByLabel("客户姓名").fill(姓名);
  await 弹窗.getByLabel("联系电话").fill(手机);
  const 负责人 = 弹窗.getByLabel("销售负责人");
  if (await 负责人.count()) {
    await 负责人.click();
    const 下拉 = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
    await 下拉.waitFor({ state: "visible" });
    await 下拉.locator(".ant-select-item-option").first().click();
  }
  await 弹窗.getByRole("button", { name: /保\s*存/ }).click();
  await expect(弹窗).toBeHidden();
}

async function 登录(page: Page, 账号: string, 密码: string) {
  await page.goto("/login");
  // 托管版的账号就是邮箱，登录框那一格也就叫「邮箱」（自部署那边才是「用户名」）
  await page.getByPlaceholder("邮箱").fill(账号);
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
  await 建客户(page, "共享区的客户甲", "13900001111");
  await expect(page.locator("main").getByText("共享区的客户甲").first()).toBeVisible({ timeout: 15_000 });
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
  // 先确认真的进了设置页：在登录页上断言「没有 AI 接入」永远成立，那是假的绿。
  // 页面标题是名词本身（批 2 起）：「设置」，不是「设置管理」
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible({ timeout: 15_000 });
  /**
   * 这里的用户角色是 ADMIN（他得能展示管理员看到的东西），但那套密码发给了多个团队。
   * 设置页最贵的一个按钮是 AI 接入那栏的「测试连接」：它会拿平台的 Key 往调用方
   * 自己填的地址发一次请求。服务端已经不给过 requireAdmin，界面这边也不该摆。
   */
  await expect(page.getByText("AI 接入")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /测试连接/ })).toHaveCount(0);

  /**
   * 「已登录的机器」那一栏同理，而且更糟：设备令牌挂在控制面账号上，一套账号密码
   * 在多个团队手里，于是 A 团队会看到 B 团队的机器名，「退出」还能把 B 正在用的
   * 那台桌面端踢下线。服务端那一栏在共享区回 null（settings/actions.ts 的
   * 我的控制面账号），这里钉的是界面真的没画它。
   */
  /*
    2026-10-02（排查 A3）起，共享区里「登录与密码」「个人资料」两栏整个不摆：账号是几个团队共用的，
    任何一个团队改了密码，会吊销全部会话，别的团队全被踢出、也登不回来。服务端 changeMyPassword / 改我的资料 同样拦。
    直接带 ?tab=password 进来，也看不到改密码的框、看不到「已登录的机器」。
  */
  await page.goto("/settings?tab=password");
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible({ timeout: 15_000 });
  // 先确认设置页真的画出来了（左目录有「外观」），再断言没有那两栏——在空白页上断言「没有」是假的绿
  await expect(page.getByText("外观").first()).toBeVisible();
  await expect(page.getByLabel("原密码")).toHaveCount(0);
  await expect(page.getByText("已登录的机器")).toHaveCount(0);
  await expect(page.getByText("登录与密码")).toHaveCount(0);
  await expect(page.getByText("个人资料")).toHaveCount(0);
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

/** 往共享工作区的业务库里直接塞一行（线索、渠道的电话打码要有数据才看得出来） */
function 共享区写(sql: string, ...args: string[]) {
  execFileSync("node", ["--experimental-sqlite", "-e", `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    const 人 = db.prepare('SELECT id FROM "User" ORDER BY createdAt LIMIT 1').get();
    db.prepare(process.argv[2]).run(...process.argv.slice(3).map((a) => (a === "$人" ? 人.id : a === "$现在" ? Date.now() : a)));
    db.close();
  `, path.join(ROOT, "prisma/e2e-hosted/ws", `${共享工作区.slug}.db`), sql, ...args], { stdio: "pipe" });
}

/*
  2026-10-04 补（回归核对 H-030 / H-031）：打码在函数和 AI 工具那一层钉着，但线索页、渠道页、
  操作日志明细这几处「接线」没有任何用例——任何一处回归，就是别的试用团队的真号外泄
*/
test("6b 共享工作区：线索页、渠道页、操作日志明细里的手机号也打码", async ({ page }) => {
  共享区写('INSERT INTO "Lead" (id, name, phone, source, status, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    "e2e-lead-mask", "打码线索", "13700002222", "其他", "待跟进", "$人", "$现在", "$现在");
  共享区写('INSERT INTO "Channel" (id, name, phone, channelOwnerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
    "e2e-ch-mask", "打码渠道", "13600003333", "$人", "$现在", "$现在");
  // 一条带电话明细的留痕（改电话那种：{字段, 原值, 新值}），一句话里也带着号——展开明细时两处都得是打过码的
  共享区写('INSERT INTO "AuditLog" (id, at, userId, userName, action, entity, entityId, summary, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    "e2e-audit-mask", "$现在", "$人", "试用工作区", "update", "Customer", "x",
    "修改客户「打码留痕」的电话 13500005555", JSON.stringify([{ 字段: "电话", 原值: "13500005555", 新值: "13500006666" }]));
  await 进共享区(page);

  await page.goto("/leads");
  await expect(page.locator("main").getByText("打码线索").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("main")).not.toContainText("13700002222");

  await page.goto("/channels");
  await expect(page.locator("main").getByText("打码渠道").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("main")).not.toContainText("13600003333");

  // 操作日志：第 3 条用例建「共享区的客户甲」（13900001111）时留过痕；明细全部展开也不许出现真号
  await page.goto("/settings?tab=audit");
  const 表 = page.locator(".ant-table").first();
  await expect(表).toBeVisible({ timeout: 15_000 });
  // 没有明细的行左边那格是占位（-spaced），点不动，只展开真有明细的
  const 展开键 = 表.locator(".ant-table-row-expand-icon:not(.ant-table-row-expand-icon-spaced)");
  const n = Math.min(await 展开键.count(), 20);
  for (let i = 0; i < n; i++) await 展开键.nth(i).click();
  expect(n, "至少那条造出来的留痕有明细可展开").toBeGreaterThan(0);
  await expect(表).toContainText("共享区的客户甲");
  await expect(表).toContainText("打码留痕");
  for (const 真号 of ["13900001111", "13500005555", "13500006666"]) await expect(page.locator("body")).not.toContainText(真号);
});

test("7 运营台要 token：不带、带错都是 404", async ({ page }) => {
  expect((await page.goto("/admin"))?.status()).toBe(404);
  expect((await page.goto("/admin?token=乱填的"))?.status()).toBe(404);
  // 2026-09-28 改版成左边导航 + 分页：每一页都各自验口令，子页带错口令同样 404（连外壳都不画）
  for (const 页 of ["/admin/users", "/admin/workspaces", "/admin/usage", "/admin/feedback", "/admin/users/whoever"]) {
    expect((await page.goto(`${页}?token=乱填的`))?.status(), `${页} 带错口令该是 404`).toBe(404);
  }
  await page.goto("/admin?token=e2e-admin-token");
  // 品牌 + 环境标记：这几页对着线上库，人得一眼知道自己在哪儿
  await expect(page.locator(".opx-brand")).toContainText("Daedalus Ops");
  await expect(page.locator(".opx-env")).toBeVisible();
  await expect(page.locator(".opx-kpi").first()).toContainText("注册用户", { timeout: 15_000 });
  // 工作区搬去了导航里的「工作区」页；导航的链接要把口令带着走，否则一点就 404
  await page.getByRole("navigation", { name: "运营台导航" }).getByRole("link", { name: "工作区" }).click();
  await expect(page).toHaveURL(/\/admin\/workspaces\?token=e2e-admin-token/);
  await expect(page.locator(".ant-table").first().getByText(共享工作区.名称, { exact: true })).toBeVisible({ timeout: 15_000 });
});

/*
  H-070（2026-09-28 用户说运营台点起来好卡）：慢的是到香港那一趟，点下去页面纹丝不动、像没点上。
  修法（ba3a101）：导航整页预取 + 没取好时哪里在等就挂 .opx-pending（导航那一项先亮、正文变暗、指针转圈）。
  这里暂停服务端回包，模拟线上等待：点了以后 600ms 内要看得出「在等」，检查完再放行，到了以后记号消失；
  每一页都点得开、口令跟着走
*/
test("7b 运营台：导航每一页都点得开、口令跟着走；回包慢时点了当场看得出在等（H-070）", async ({ page }) => {
  // 先拦住预取和导航，避免固定延时在检查样式前已到期、或 networkidle 已把预取等完。
  let 放行!: () => void;
  let 回包关卡 = new Promise<void>((resolve) => { 放行 = resolve; });
  let 拖慢 = true;
  await page.route(
    (u) => u.searchParams.has("_rsc"),
    async (route) => {
      if (拖慢) await 回包关卡;
      await route.continue().catch(() => {});
    },
  );
  await page.goto("/admin?token=e2e-admin-token");
  await expect(page.locator(".opx-kpi").first()).toContainText("注册用户", { timeout: 15_000 });
  await page.waitForFunction(() => {
    const link = document.querySelector(".opx-nav a");
    return link && Object.keys(link).some((key) => key.startsWith("__reactProps"));
  });
  const 导航 = page.getByRole("navigation", { name: "运营台导航" });
  const 反馈 = 导航.getByRole("link", { name: "反馈" });

  try {
    await 反馈.click();
    // 当场有反馈：导航那一项里挂上记号，ops.css 用 :has() 认它——那一项先亮、正文变暗。两件事同一刻都在
    await expect(反馈.locator(".opx-pending")).toHaveCount(1, { timeout: 600 });
    await expect
      .poll(() => page.locator(".opx-main").evaluate((el) => Number(getComputedStyle(el).opacity)), { timeout: 1000, message: "等的时候正文要变暗" })
      .toBeLessThan(0.9);
    await expect(page).toHaveURL(/\/admin\?token=/); // 还没到
  } finally {
    放行();
  }
  // 到了：记号消失、正文复原、标成当前页
  await expect(page).toHaveURL(/\/admin\/feedback\?token=e2e-admin-token/, { timeout: 15_000 });
  await expect(反馈).toHaveAttribute("aria-current", "page", { timeout: 15_000 });
  await expect(page.locator(".opx-pending")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".opx-main")).toHaveCSS("opacity", "1");

  // 刷新按钮同一套：点了就转圈、写「刷新中…」、按钮先灰掉，回来复原
  const 刷新 = page.locator(".opx-side-foot button");
  回包关卡 = new Promise<void>((resolve) => { 放行 = resolve; });
  try {
    await 刷新.click();
    await expect(刷新).toContainText("刷新中", { timeout: 600 });
    await expect(刷新).toBeDisabled();
  } finally {
    放行();
  }
  await expect(刷新).not.toContainText("刷新中", { timeout: 15_000 });
  await expect(刷新).toBeEnabled();

  // 不拖慢：其余每一页点过去，限时出内容（标成当前页、正文有标题），口令跟着走
  拖慢 = false;
  for (const [名, 址] of [["用户", /\/admin\/users\?token=e2e-admin-token/], ["模型用量", /\/admin\/usage\?token=/], ["工作区", /\/admin\/workspaces\?token=/], ["团队同步", /\/admin\/sync\?token=/], ["总览", /\/admin\?token=/]] as const) {
    await 导航.getByRole("link", { name: 名 }).click();
    await expect(page, `点「${名}」`).toHaveURL(址, { timeout: 15_000 });
    await expect(导航.getByRole("link", { name: 名 })).toHaveAttribute("aria-current", "page", { timeout: 15_000 });
    await expect(page.locator(".opx-head h1, .opx-kpi").first()).toBeVisible();
    await expect(page.locator(".opx-pending")).toHaveCount(0, { timeout: 15_000 });
  }
});

/*
  团队版按时长开通（2026-10-15）：运营台「团队同步」点「开通 / 续费」，选时长和人数、按价格表看应收，确认后有到期日；
  改到期日到昨天 = 已到期；每次操作在展开行里留记录；价格表能改。团队直接写进控制面库（建团队要桌面端的设备令牌，这里不走那条路）
*/
test("7c 运营台团队同步：按时长开通、看到期、改到期日、改价格", async ({ page }) => {
  execFileSync("node", ["--experimental-sqlite", "-e", `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.prepare('INSERT INTO "SyncTeam" ("id", "name", "ownerAccountId", "joinSecretHash", "active") VALUES (?, ?, ?, ?, 0)').run('e2eplanteam0001', 'E2E 计费团队', 'nobody', 'x');
    db.close();
  `, CONTROL_DB]);
  await page.goto("/admin/sync?token=e2e-admin-token");
  await expect(page.locator(".opx-prices")).toContainText("¥29.9", { timeout: 15_000 });
  await expect(page.locator(".opx-prices")).toContainText("¥299");
  const 行 = page.locator("tr", { hasText: "E2E 计费团队" });
  await expect(行.getByText("待开通")).toBeVisible();

  await 行.getByRole("button", { name: "开通 / 续费" }).click();
  const 框 = page.getByRole("dialog", { name: /开通 \/ 续费/ });
  await 框.getByText("3 个月", { exact: true }).click();
  await 框.getByRole("spinbutton").first().fill("3");
  // 84.9 × 3 = 254.7（按分四舍五入，不是 254.70000000000002）
  await expect(框.getByText("¥254.7", { exact: true })).toBeVisible();
  await expect(框).toContainText("每人 ¥84.9 × 3 人");
  await 框.getByPlaceholder(/微信转账/).fill("e2e 微信转账");
  await 框.getByRole("button", { name: "确认开通" }).click();
  await expect(page.getByText(/已开通，到期 \d{4}-\d{2}-\d{2}/)).toBeVisible({ timeout: 15_000 });
  await expect(行.getByText("已开通")).toBeVisible({ timeout: 15_000 });
  await expect(行.locator(".opx-due")).toContainText(/剩 9\d 天/);
  await expect(行).toContainText("0 / 3");
  // 展开看记录：谁、时长、人数、实收、备注
  await 行.getByRole("button", { name: /展开|Expand/ }).click();
  await expect(page.locator(".opx-plan-log")).toContainText("开通 · 3 个月 · 3 人 · 实收 ¥254.7");
  await expect(page.locator(".opx-plan-log")).toContainText("e2e 微信转账");
  await expect(page.locator(".opx-plan-log")).toContainText("口令");

  // 改到期日到昨天：显示已到期、已过期 1 天
  const 昨天 = new Date(Date.now() + 8 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
  await 行.getByRole("button", { name: /更多操作/ }).click();
  await page.getByRole("menuitem", { name: "改到期日" }).click();
  const 改 = page.getByRole("dialog", { name: /改到期日/ });
  await 改.locator('input[type="date"]').fill(昨天);
  // antd 给两个汉字的按钮中间加空格：「保 存」
  await 改.getByRole("button", { name: /保\s*存/ }).click();
  await expect(行.getByText("已到期")).toBeVisible({ timeout: 15_000 });
  await expect(行.locator(".opx-due")).toContainText("已过期 1 天");
  expect(查控制面('SELECT COUNT(*) FROM "SyncTeamPlanLog" WHERE "teamId" = ?', "e2eplanteam0001")).toBe("2");

  // 改价格：1 个月改成 19.9，卡片上马上是新价；再改回来
  for (const 价 of ["19.9", "29.9"]) {
    await page.getByRole("button", { name: "改价格" }).click();
    const 价框 = page.getByRole("dialog", { name: /改价格/ });
    await 价框.getByRole("spinbutton").first().fill(价);
    await 价框.getByRole("button", { name: /保\s*存/ }).click();
    await expect(page.locator(".opx-price").first()).toContainText(`¥${价}`, { timeout: 15_000 });
  }
});

/*
  运营台手动加次数（2026-10-19）：「次数」页搜到个人客户，加背调、加 AI；团队同步点进团队，给成员加两种；
  确认按钮连点两下只加一次；每次都在加次记录里（谁、几次、备注、团队）。账号和团队直接写进控制面库（e2e 自己造的）。
  E2E_SHOTS=目录 时顺手截图（给总控看界面用），平时不截
*/
test("7d 运营台加次数：个人加背调 / AI、团队成员加两种、连点只加一次、都留记录", async ({ page }) => {
  execFileSync("node", ["--experimental-sqlite", "-e", `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    const 人 = db.prepare('INSERT INTO "Account" ("id", "email", "password", "name") VALUES (?, ?, ?, ?)');
    人.run('e2ecredit-solo', 'credit.buyer@e2e.local', 'x', '个人客户老周');
    人.run('e2ecredit-boss', 'credit.boss@e2e.local', 'x', '团队陈老板');
    人.run('e2ecredit-staff', 'credit.staff@e2e.local', 'x', '业务员小王');
    db.prepare('INSERT INTO "SyncTeam" ("id", "name", "ownerAccountId", "joinSecretHash", "active") VALUES (?, ?, ?, ?, 1)').run('e2ecreditteam01', 'E2E 外贸一部', 'e2ecredit-boss', 'x');
    const 成员 = db.prepare('INSERT INTO "SyncMember" ("teamId", "accountId", "role") VALUES (?, ?, ?)');
    成员.run('e2ecreditteam01', 'e2ecredit-boss', 'owner');
    成员.run('e2ecreditteam01', 'e2ecredit-staff', 'member');
    const 设备 = db.prepare('INSERT INTO "SyncDevice" ("teamId", "device", "accountId", "pubKey") VALUES (?, ?, ?, ?)');
    设备.run('e2ecreditteam01', 'e2e-d1', 'e2ecredit-boss', 'k');
    设备.run('e2ecreditteam01', 'e2e-d2', 'e2ecredit-boss', 'k');
    设备.run('e2ecreditteam01', 'e2e-d3', 'e2ecredit-staff', 'k');
    db.close();
  `, CONTROL_DB]);
  const 截图 = async (名: string) => {
    if (!process.env.E2E_SHOTS) return;
    // 等右上角的「加了 N 次」提示消失再拍，弹框的动画走完
    await expect(page.locator(".ant-message-notice")).toHaveCount(0, { timeout: 15_000 });
    await page.screenshot({ path: path.join(process.env.E2E_SHOTS, `${名}.png`), fullPage: true, animations: "disabled" });
  };
  const 送了 = (表: "ResearchGrant" | "AccountAiGrant", id: string) => 查控制面(`SELECT COALESCE(SUM("amount"), 0) FROM "${表}" WHERE "accountId" = ? AND "reason" = 'admin'`, id);
  async function 加(按钮: string, 框名: RegExp, 几: string, 备注: string, 连点 = false) {
    await page.getByRole("button", { name: 按钮 }).click();
    const 框 = page.getByRole("dialog", { name: 框名 });
    await 框.getByRole("spinbutton").fill(几);
    if (备注) await 框.getByLabel("备注").fill(备注);
    const 确认 = 框.getByRole("button", { name: `确认加 ${几} 次` });
    if (连点) await 确认.dblclick();
    else await 确认.click();
    await expect(框).toBeHidden({ timeout: 15_000 });
  }

  // 导航上有「次数」；按邮箱搜到个人客户
  await page.goto("/admin?token=e2e-admin-token");
  await page.getByRole("link", { name: "次数" }).click();
  await expect(page).toHaveURL(/\/admin\/credits\?token=e2e-admin-token/, { timeout: 15_000 });
  await page.getByLabel("搜账号").fill("credit.buyer");
  await page.getByLabel("搜账号").press("Enter");
  await expect(page).toHaveURL(/q=credit\.buyer/, { timeout: 15_000 });
  const 行 = page.locator(".opx-credit-accounts tbody tr", { hasText: "credit.buyer@e2e.local" });
  await expect(行).toHaveCount(1);
  await expect(page.locator(".opx-credit-accounts tbody tr")).toHaveCount(1);

  // 个人加背调 10 次（写备注），再加 AI 200 次
  await 加("给 个人客户老周 加背调次数", /加背调次数/, "10", "微信转账 10 次");
  await expect(page.getByText("给 个人客户老周 加了 10 次背调")).toBeVisible();
  expect(送了("ResearchGrant", "e2ecredit-solo")).toBe("10");
  await expect(行.locator("td").nth(1)).toContainText("10", { timeout: 15_000 });
  await 加("给 个人客户老周 加AI次数", /加AI次数/, "200", "支付宝 200 次");
  expect(送了("AccountAiGrant", "e2ecredit-solo")).toBe("200");
  await expect(行.locator("td").nth(2)).toContainText("200", { timeout: 15_000 });

  // 连点两下确认：只加一次
  await 加("给 个人客户老周 加背调次数", /加背调次数/, "5", "", true);
  expect(送了("ResearchGrant", "e2ecredit-solo")).toBe("15");
  expect(查控制面('SELECT COUNT(*) FROM "AdminCreditLog" WHERE "accountId" = ?', "e2ecredit-solo")).toBe("3");
  await expect(行.locator("td").nth(1)).toContainText("15", { timeout: 15_000 });

  // 加次记录：新的在上，谁加的（口令进来的记「口令」）、几次、备注
  const 记录 = page.locator(".opx-credit-log tbody tr");
  await expect(记录.first()).toContainText("+5");
  await expect(page.locator(".opx-credit-log")).toContainText("微信转账 10 次");
  await expect(page.locator(".opx-credit-log")).toContainText("支付宝 200 次");
  await expect(记录.first()).toContainText("口令");
  await 截图("1-次数页");

  // 团队：团队同步列表里点团队名进去，成员、角色、设备数都在
  await page.goto("/admin/sync?token=e2e-admin-token");
  await expect(page.getByRole("link", { name: /E2E 外贸一部：看成员、加次数/ })).toBeVisible({ timeout: 15_000 });
  await 截图("0-团队同步列表");
  await page.getByRole("link", { name: /E2E 外贸一部：看成员、加次数/ }).click();
  await expect(page).toHaveURL(/\/admin\/sync\/e2ecreditteam01\?token=e2e-admin-token/, { timeout: 15_000 });
  const 成员们 = page.locator(".opx-team-members tbody tr");
  await expect(成员们).toHaveCount(2);
  await expect(成员们.first()).toContainText("团队陈老板");
  await expect(成员们.first()).toContainText("建的人");
  await expect(成员们.first()).toContainText("2 台");
  await expect(成员们.nth(1)).toContainText("credit.staff@e2e.local");
  await expect(成员们.nth(1)).toContainText("成员");

  // 给业务员加背调 3 次、AI 50 次
  await 加("给 业务员小王 加背调次数", /加背调次数/, "3", "团队买的背调");
  await 加("给 业务员小王 加AI次数", /加AI次数/, "50", "");
  expect(送了("ResearchGrant", "e2ecredit-staff")).toBe("3");
  expect(送了("AccountAiGrant", "e2ecredit-staff")).toBe("50");
  expect(查控制面('SELECT "teamId" FROM "AdminCreditLog" WHERE "accountId" = ? LIMIT 1', "e2ecredit-staff")).toBe("e2ecreditteam01");
  await expect(成员们.nth(1).locator("td").nth(4)).toContainText("3", { timeout: 15_000 });
  await expect(成员们.nth(1).locator("td").nth(5)).toContainText("50", { timeout: 15_000 });
  // 团队页的记录只有这两个成员的，带团队名
  await expect(page.locator(".opx-credit-log tbody tr")).toHaveCount(2);
  await expect(page.locator(".opx-credit-log")).toContainText("团队「E2E 外贸一部」");
  await expect(page.locator(".opx-credit-log")).not.toContainText("个人客户老周");
  await 截图("2-团队详情");
  // 弹框的样子
  await page.getByRole("button", { name: "给 团队陈老板 加背调次数" }).click();
  await page.getByRole("dialog", { name: /加背调次数/ }).getByLabel("备注").fill("微信转账 10 次");
  await 截图("3-加次弹框");
  await page.getByRole("dialog", { name: /加背调次数/ }).getByRole("button", { name: /取\s*消/ }).click();
  expect(送了("ResearchGrant", "e2ecredit-boss")).toBe("0");
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
  await page.getByPlaceholder(/问一位客户/).fill("还剩多少次");
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

test("11 反馈：界面里发一句话，运营台当场看得见", async ({ page }) => {
  await 进共享区(page);
  const 话 = `e2e 反馈 ${Date.now()}：客户列表的筛选记不住`;

  await page.getByRole("button", { name: /反馈/ }).click();
  await page.getByRole("dialog").getByRole("textbox").fill(话);
  // 发之前先确认那句承诺在人眼前——它是这个框允许我们附带版本和路径的全部理由
  await expect(page.getByRole("dialog")).toContainText("不含任何客户、商机或跟进数据");
  // 限定在框里：首页那个问 AI 的输入框上也有个「发送」，页面上同时有两个。
  // 名字用正则：antd 中文会在两个字之间插一个空格（和登录那条一样的坑）
  await page.getByRole("dialog").getByRole("button", { name: /发\s*送/ }).click();
  await expect(page.getByText("收到了，谢谢")).toBeVisible({ timeout: 15_000 });

  // 落到控制面库，运营台那一页读的就是它。没人看的收件箱等于没有这个功能
  // 2026-09-28 起反馈是运营台的一页（导航上带着没处理的红数）
  await page.goto("/admin/feedback?token=e2e-admin-token");
  await expect(page.getByText(话)).toBeVisible({ timeout: 15_000 });
  // 附带那几样也要在：谁发的、哪一页发的
  await expect(page.locator(".opx-fb").first()).toContainText("/dashboard");
});

test("12 忘记密码：收码、设新密码，旧会话当场作废", async ({ page }) => {
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

  const mailboxUrl = `http://127.0.0.1:${(Number(process.env.HOSTED_E2E_PORT) || 3400) + 2}/messages`;
  let code = "";
  await expect.poll(async () => {
    const response = await page.request.get(mailboxUrl);
    const messages = await response.json() as { recipient: string; subject: string }[];
    code = /^(\d{6}) 是你的 /.exec(messages.findLast(m => m.recipient === 共享工作区.邮箱)?.subject ?? "")?.[1] ?? "";
    return code.length;
  }).toBe(6);
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
   * 所以它必须是最后一条要登录的用例。后面只剩第 13 条，它只看登录页上有没有那个链接。
   * 要在它后面加需要登录的用例，就得先把这里的密码问题解决掉。
   */
});

test("13 登录页把找回入口摆出来", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "忘记密码？" })).toHaveAttribute("href", "/forgot");
});

/**
 * 2026-09-20：注册入口原来只画给桌面端看，网页登录页一个字都没有——于是网页上点进登录的人
 * 会以为这个产品不收新用户。
 * 2026-10-14 对外口径：注册在桌面端里做，浏览器登录页的注册入口指向官网下载页。
 */
test("13b 登录页也给注册入口，指向下载页", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "下载桌面端" })).toHaveAttribute("href", "https://ai-daedalus.com/download.html");
});
