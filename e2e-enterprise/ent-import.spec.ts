/**
 * 企业版导入：测试机那套样例在真浏览器里走一趟来回。
 *
 * 库里先由 prepare.ts（起服务前跑）放好测试机的状态（样例的 26 个在职账号 + 一家已有客户），然后照测试机那天的点法：
 *   设置 → 企业版导入 → 传四个表 → 试跑 → 正式导入 → 同样四个表再导一次 → 批次里两批倒着撤回
 *
 * 裁判三件事（库直接读，不看界面怎么说）：
 *   1. 试跑报告（先演一遍那张表）的数 = 导入完成弹窗的数 = 库里各表实际多出来 / 改了的行，逐类对上；试跑本身不动库
 *   2. 同一批导两次不重复：第二次报告零新建零更新，导完库一格不变
 *   3. 来回：两批撤回后，除日志表外每张表和导入前逐行一样（只有 updatedAt 不比）
 * 和 tests/ent-import-judges.test.ts 同一套裁判，那边直接调函数，这里走上传接口、server action 和页面。
 */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { Prisma, PrismaClient } from "../src/generated/prisma";
import { 实体名, 实体顺序, type 实体 } from "../src/lib/enterprise-import/types";
import { ENT_E2E_DB } from "./env";

const 样例 = path.resolve(__dirname, "../tests/fixtures/ent-sample");
const 四个表 = ["客户.xlsx", "联系人.xlsx", "商机.xlsx", "跟进记录.xlsx"].map((f) => path.join(样例, f));
const 模型: Record<实体, string> = { customer: "Customer", contact: "Contact", lead: "Lead", opportunity: "Opportunity", followup: "FollowUp" };

const prisma = new PrismaClient({ datasourceUrl: `file:${ENT_E2E_DB}` });
test.afterAll(() => prisma.$disconnect());

/* 日志 / 回收区本来就会多出来，不算在「来回」里；其余每张表都比 */
const 不比 = new Set(["AuditLog", "EntImportBatch", "EntImportRow", "EntTrash", "EntSnapshot"]);
type 快照 = Record<string, string[]>;
async function 拍(): Promise<快照> {
  const 照: 快照 = {};
  for (const m of Prisma.dmmf.datamodel.models) {
    if (不比.has(m.name)) continue;
    const d = (prisma as unknown as Record<string, { findMany: () => Promise<unknown[]> }>)[m.name[0].toLowerCase() + m.name.slice(1)];
    照[m.name] = (await d.findMany()).map((r) => JSON.stringify(r)).sort();
  }
  return 照;
}
const 按id = (行们: string[]) => new Map(行们.map((x) => [JSON.parse(x).id as string, x]));

type 五数 = { 新建: number; 更新: number; 跳过: number; 冲突: number; 失败: number };

async function 登录(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("用户名").fill("admin");
  await page.getByPlaceholder("登录密码").fill("admin123");
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await page.waitForURL(/\/dashboard/);
}

/* antd 的两字按钮中间会插一个空格（「试 跑」），所以按钮名用正则 */
/** 打开设置 → 企业版导入 → 导入页签，传四个表点试跑，等报告出来 */
async function 试跑(page: Page) {
  await page.goto("/settings?tab=enterprise");
  await page.getByRole("tab", { name: "导入", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(四个表);
  await page.getByRole("button", { name: /^试\s*跑$/ }).click();
  await expect(page.getByText("先照正式导入演了一遍")).toBeVisible({ timeout: 60_000 });
}

/** 报告里「先照正式导入演了一遍」那张表：每类五个数 + 合计 */
async function 读预演(page: Page) {
  const 表 = page.locator(".ant-table-wrapper").filter({ has: page.locator(".ant-table-title", { hasText: "先照正式导入演了一遍" }) });
  const 按类: Partial<Record<实体, 五数>> = {};
  for (const tr of await 表.locator("tbody tr.ant-table-row").all()) {
    const 格 = (await tr.locator("td").allInnerTexts()).map((s) => s.trim());
    const e = 实体顺序.find((k) => 实体名[k] === 格[0]);
    expect(e, `认不出类别「${格[0]}」`).toBeTruthy();
    const [新建, 更新, 跳过, 冲突, 失败] = 格.slice(1).map(Number);
    按类[e!] = { 新建, 更新, 跳过, 冲突, 失败 };
  }
  const 标题 = await 表.locator(".ant-table-title").innerText();
  const m = 标题.match(/新建 (\d+) 条、更新 (\d+) 条、跳过 (\d+) 条、冲突 (\d+) 条、写不进 (\d+) 条/);
  expect(m, 标题).toBeTruthy();
  const [新建, 更新, 跳过, 冲突, 失败] = m!.slice(1).map(Number);
  const 合计 = { 新建, 更新, 跳过, 冲突, 失败 };
  // 标题的合计 = 各类相加，免得表和标题各说各的。跳过另算上清洗时就跳过的（报告 report.ts：合计.跳过从清洗的跳过起算）
  const 清洗跳过 = (await 汇总列(page, "跳过")).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(合计) as (keyof 五数)[]) {
    const 各类 = Object.values(按类).reduce((a, c) => a + c![k], 0);
    expect(各类 + (k === "跳过" ? 清洗跳过 : 0), `预演合计 ${k}`).toBe(合计[k]);
  }
  return { 按类, 合计 };
}

/** 报告最上面「一共 N 条」那张清洗汇总表 */
const 汇总表 = (page: Page) => page.locator(".ant-table-wrapper").filter({ has: page.locator(".ant-table-title", { hasText: /^一共 \d+ 条/ }) });

/** 清洗汇总表某一列，每类一个数 */
async function 汇总列(page: Page, 列名: string): Promise<number[]> {
  const 表 = 汇总表(page);
  const 头 = (await 表.locator("thead th").allInnerTexts()).map((s) => s.trim());
  const i = 头.indexOf(列名);
  expect(i, `清洗汇总表没有「${列名}」列：${头.join("、")}`).toBeGreaterThanOrEqual(0);
  const 数 = [];
  for (const tr of await 表.locator("tbody tr.ant-table-row").all()) 数.push(Number((await tr.locator("td").nth(i).innerText()).trim()));
  return 数;
}

/** 点「确认，正式导入」→「导入」，读完成弹窗的数，关掉弹窗 */
async function 正式导入(page: Page): Promise<五数> {
  await page.getByRole("button", { name: "确认，正式导入" }).click();
  await page.locator(".ant-popconfirm:not(.ant-popover-hidden)").getByRole("button", { name: /^导\s*入$/ }).click();
  const 弹窗 = page.getByRole("dialog").filter({ hasText: "导入完成" });
  await expect(弹窗).toBeVisible({ timeout: 120_000 });
  const 话 = await 弹窗.innerText();
  const m = 话.match(/新建 (\d+)，更新 (\d+)，跳过 (\d+)/);
  expect(m, 话).toBeTruthy();
  const r = {
    新建: Number(m![1]),
    更新: Number(m![2]),
    跳过: Number(m![3]),
    冲突: Number(话.match(/(\d+) 条和我们这边改过的冲突/)?.[1] ?? 0),
    失败: Number(话.match(/(\d+) 条没写进去/)?.[1] ?? 0),
  };
  await 弹窗.getByRole("button").last().click();
  await expect(弹窗).toBeHidden();
  return r;
}

test.describe.configure({ mode: "serial" });

test.describe("企业版导入：测试机样例一趟来回", () => {
  let 导入前: 快照;
  let 第一批后: 快照;

  test("测试机准备脚本放好了：26 个在职账号 + 一家已有客户", async () => {
    expect(await prisma.user.count({ where: { role: "SALES", active: true } })).toBe(26);
    expect(await prisma.customer.count({ where: { remark: "测试机上本来就有" } })).toBe(1);
    导入前 = await 拍();
  });

  test("试跑 → 正式导入：试跑不动库；预演的数 = 完成弹窗的数 = 库里各表增减", async ({ page }) => {
    await 登录(page);
    // 第一次进页面应用会补记一个设置（phone.extKeptSince，见 lib/phone-dedupe），和导入无关：「导入前」从登录之后算
    导入前 = await 拍();
    await 试跑(page);
    const 演 = await 读预演(page);
    expect(await 拍(), "试跑不该动库").toEqual(导入前);
    // 样例的预期（说明.md）：有新建、已有那家客户会被补空更新、没有冲突、没有写不进
    expect(演.合计.新建).toBeGreaterThan(0);
    expect(演.按类.customer?.更新).toBe(1);
    expect([演.合计.冲突, 演.合计.失败]).toEqual([0, 0]);

    const r = await 正式导入(page);
    expect(r, "完成弹窗 = 预演").toEqual(演.合计);

    第一批后 = await 拍();
    for (const e of 实体顺序) {
      const 旧 = 按id(导入前[模型[e]]);
      const 新 = 按id(第一批后[模型[e]]);
      const 多 = [...新.keys()].filter((id) => !旧.has(id)).length;
      const 改 = [...新.keys()].filter((id) => 旧.has(id) && 旧.get(id) !== 新.get(id)).length;
      const 少 = [...旧.keys()].filter((id) => !新.has(id)).length;
      const c = 演.按类[e] ?? { 新建: 0, 更新: 0 };
      expect([e, 多, 改, 少], "库里各表增减 = 预演").toEqual([e, c.新建, c.更新, 0]);
    }
    // 新建、补空（更新 / 没空可补的跳过）、同批并入（跳过）每条都记一条原系统 ID 对照；清洗时就跳过的不进计划，不记
    const 记对照 = Object.values(演.按类).reduce((a, c) => a + c!.新建 + c!.更新 + c!.跳过, 0);
    expect(第一批后.EntExternalRef.length - 导入前.EntExternalRef.length, "写了的每条都记了原系统 ID").toBe(记对照);
    expect(第一批后.EntConflict.length - 导入前.EntConflict.length).toBe(0);
  });

  test("同一批再导一次：报告零新建零更新，导完库一格不变", async ({ page }) => {
    await 登录(page);
    await 试跑(page);
    const 演 = await 读预演(page);
    expect([演.合计.新建, 演.合计.更新, 演.合计.冲突, 演.合计.失败]).toEqual([0, 0, 0, 0]);
    // 清洗那张表也该说零新建零更新（都归没变 / 并入已有）
    for (const 列 of ["新建", "更新"]) expect((await 汇总列(page, 列)).every((n) => n === 0), `再导一次的报告：${列}都该是 0`).toBe(true);

    const r = await 正式导入(page);
    expect([r.新建, r.更新, r.冲突, r.失败]).toEqual([0, 0, 0, 0]);
    expect(await 拍(), "同一批导两次，库不该变").toEqual(第一批后);
  });

  test("批次里两批倒着撤回：除日志表外每张表和导入前逐行一样", async ({ page }) => {
    await 登录(page);
    await page.goto("/settings?tab=enterprise");
    await page.getByRole("tab", { name: "批次", exact: true }).click();
    const 已导入 = page.locator("tbody tr.ant-table-row").filter({ hasText: "已导入" });
    await expect(已导入).toHaveCount(2);
    // 批次按时间倒序：每次撤最上面那批已导入的，就是先撤第二批、再撤第一批
    for (let i = 0; i < 2; i++) {
      await 已导入.first().getByRole("button", { name: /^撤\s*回$/ }).click();
      await page.locator(".ant-popconfirm:not(.ant-popover-hidden)").getByRole("button", { name: /^撤\s*回$/ }).click();
      const 弹窗 = page.getByRole("dialog").filter({ hasText: "整批撤回完成" });
      await expect(弹窗).toBeVisible({ timeout: 120_000 });
      // 撤回不该留下没动的（导入之后没人改过）
      expect(await 弹窗.innerText()).not.toContain("后来又被改过");
      await 弹窗.getByRole("button").last().click();
      await expect(弹窗).toBeHidden();
      await expect(已导入).toHaveCount(1 - i);
    }
    await expect(page.locator("tbody tr.ant-table-row").filter({ hasText: "已撤回" })).toHaveCount(2);

    // Prisma 的 @updatedAt 撤回时会跟着动（已有客户补过空又退回）：只这一项不比
    const 去时间 = (照: 快照) => Object.fromEntries(Object.entries(照).map(([k, v]) => [k, v.map((r) => r.replace(/"updatedAt":"[^"]*"/, "")).sort()]));
    expect(去时间(await 拍()), "撤完和导入前一样").toEqual(去时间(导入前));
  });
});
