/**
 * 团队「同事之间互相看得到客户」+ 老板把公海客户指派给业务员（2026-10-20，客户需求）。
 *
 * 接着 09（两档权限）造的那台：.team.json 一放，「我」按假云端的名单对成业务员或老板。
 *   - 业务员、开着：列表、搜索、跟进页看得到老板的客户；打开是只读的（横条写明，没有编辑 / 删除），能记跟进
 *   - 业务员、关掉：回到自己的 + 公海，老板的客户又「找不到」
 *   - 老板：设置 → 团队有这个开关，开 / 关都先弹一次确认（说清看过、导出过的收不回）；公海里「分配给…」单条 + 批量，能撤销
 * 名字故意很长、窗口用桌面端最窄（1024 × 700，desktop/main.js minWidth），每一屏量一次排版（e2e/layout-audit.ts）。
 * SHOT_DIR 给了就把开关和公海分配各截一张（PR 用）。
 * 收尾照 09：.team.json 挪掉，「我」回成唯一的在职管理员。
 */
import { test, expect, type Page } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { 查排版, 说问题 } from "../e2e/layout-audit";
import { DATA_DIR, 云端账号 } from "./env";
import { 设云端团队, 连库, 进门 } from "./helpers";

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1024, height: 700 } });

const 我id = `acct_${云端账号.id}`;
const 老板id = "acct_acc_boss";
const 小周id = "acct_acc_zhou";
const 名 = {
  老板的: "互看-老板的客户·深圳市前海国际贸易有限公司华南大区采购中心",
  我的: "互看-我的客户",
  公海: "互看-公海客户·广州番禺精密五金制品有限公司",
  公海二: "互看-公海客户二",
};
const 小周 = "小周·华东区域业务经理（新人）";
const id: Record<string, string> = {};
const 成员 = (我是老板: boolean) => [
  { accountId: "acc_boss", name: "王老板", contact: "boss@e2e.local", role: 我是老板 ? "member" : "owner" },
  { accountId: 云端账号.id, name: 云端账号.name, contact: 云端账号.contact, role: 我是老板 ? "owner" : "member" },
  { accountId: "acc_zhou", name: 小周, contact: "zhou@e2e.local", role: "member" },
];
const 团队 = (我是老板: boolean, 互看: boolean) => ({ id: "t_e2e", name: "E2E 团队", active: true, 我是建的人: 我是老板, 互看, 成员: 成员(我是老板) });
const 截图 = async (page: Page, 文件: string) => {
  if (!process.env.SHOT_DIR) return;
  await page.waitForTimeout(400); // 弹窗、菜单的入场动画走完再拍
  await page.screenshot({ path: path.join(process.env.SHOT_DIR, 文件) });
};
async function 排版没问题(page: Page) {
  // next dev 左下角的开发浮层不是产品的一部分（同 e2e/team-qa-ops.spec.ts）
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  const 问题 = await 查排版(page);
  expect(问题, 说问题(问题)).toEqual([]);
}
/** 设置 → 团队打开一次 = 按名单对角色、记下开关；限定有 3 秒缓存，等它过期 */
async function 对齐(page: Page) {
  await 进门(page, "/settings?tab=team");
  await expect(page.getByRole("tabpanel", { name: /^团队/ }).getByRole("heading", { name: "E2E 团队" })).toBeVisible();
  await page.waitForTimeout(3500);
}

test.beforeAll(async ({ request }) => {
  const p = 连库();
  try {
    await p.user.update({ where: { id: 老板id }, data: { active: true } });
    await p.user.upsert({ where: { id: 小周id }, create: { id: 小周id, email: "zhou@e2e.local", name: 小周, password: "x", role: "ADMIN", title: "业务员" }, update: { active: true, name: 小周 } });
    id.老板的 = (await p.customer.create({ data: { name: 名.老板的, phone: "13600000101", salesOwnerId: 老板id } })).id;
    id.我的 = (await p.customer.create({ data: { name: 名.我的, phone: "13600000102", salesOwnerId: 我id } })).id;
    id.公海 = (await p.customer.create({ data: { name: 名.公海, phone: "13600000103", salesOwnerId: 老板id } })).id;
    id.公海二 = (await p.customer.create({ data: { name: 名.公海二, phone: "13600000104", salesOwnerId: 老板id } })).id;
    await p.customerPool.createMany({ data: [{ customerId: id.公海, reason: "手动" }, { customerId: id.公海二, reason: "手动" }] });
    await p.followUp.create({ data: { customerId: id.老板的, ownerId: 老板id, type: "CALL", title: "电话", content: "老板谈的互看价", status: "已完成", occurredAt: new Date() } });
    await p.opportunity.create({ data: { customerId: id.老板的, ownerId: 老板id, name: "老板的互看大单", amount: 880_000 } });
    await p.task.create({ data: { customerId: id.公海, ownerId: 老板id, title: "公海客户没做完的待办" } });
  } finally {
    await p.$disconnect();
  }
  await 设云端团队(request, 团队(false, true));
  writeFileSync(
    path.join(DATA_DIR, ".team.json"),
    JSON.stringify({ teamId: "t_e2e", teamName: "E2E 团队", joinSecret: "e2e", key: "A".repeat(43), device: "dev_e2e", pulled: 0 }),
    { mode: 0o600 },
  );
});

test.afterAll(async ({ request }) => {
  rmSync(path.join(DATA_DIR, ".team.json"), { force: true });
  // 假云端的名单还原成 09 留下的样子（我是业务员、没有互看），后面几组看到的和没有这一组时一样
  await 设云端团队(request, { id: "t_e2e", name: "E2E 团队", active: true, 我是建的人: false, 成员: 成员(false).slice(0, 2) });
  const p = 连库();
  try {
    await p.customer.deleteMany({ where: { id: { in: Object.values(id) } } });
    await p.user.update({ where: { id: 我id }, data: { role: "ADMIN", active: true } });
    await p.user.updateMany({ where: { id: { not: 我id } }, data: { active: false } });
  } finally {
    await p.$disconnect();
  }
});

test("业务员、开着：看得到老板的客户、跟进、商机；打开是只读的，只能记跟进", async ({ page }) => {
  await 对齐(page);
  const 栏 = page.getByRole("tabpanel", { name: /^团队/ });
  await expect(栏).toContainText("你是业务员：团队开了「同事之间互相看得到客户」");
  // 开关只有老板能改：业务员这边不摆
  await expect(page.getByTestId("team-share")).toHaveCount(0);

  await 进门(page, `/customers?keyword=${encodeURIComponent("互看-")}`);
  await expect(page.locator("main").getByRole("link", { name: 名.老板的 })).toBeVisible();
  await expect(page.locator("main").getByRole("link", { name: 名.我的 })).toBeVisible();
  await 排版没问题(page);
  // 业务员的公海页签：没有「分配给…」
  await 进门(page, `/customers?pool=1&keyword=${encodeURIComponent("互看-")}`);
  await expect(page.locator("main").getByRole("link", { name: 名.公海 })).toBeVisible();
  await expect(page.getByRole("button", { name: /^分配 .* 给…$/ })).toHaveCount(0);

  await page.goto("/follow-ups");
  await expect(page.locator("main")).toContainText("老板谈的互看价");
  await page.goto("/opportunities");
  await expect(page.locator("main")).toContainText("老板的互看大单");

  await 进门(page, `/customers/${id.老板的}`);
  await expect(page.getByRole("heading", { name: 名.老板的 })).toBeVisible();
  await expect(page.locator(".rec-readonly")).toContainText("同事 王老板 的客户 · 只能看和加跟进");
  await expect(page.getByRole("button", { name: /编辑全部/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /新建商机/ })).toHaveCount(0);
  await 排版没问题(page);
  // 记一笔跟进：可以
  await page.getByRole("button", { name: /记录跟进/ }).first().click();
  const 框 = page.getByRole("dialog");
  await 框.getByLabel("沟通内容").fill("替王老板接了个电话，客户问交期");
  await expect(框.getByText("下一步")).toHaveCount(0);
  await 框.getByRole("button", { name: /保\s*存|确\s*定/ }).click();
  await expect(page.locator("main").getByText("替王老板接了个电话，客户问交期")).toBeVisible();
  const p = 连库();
  try {
    expect(await p.followUp.count({ where: { customerId: id.老板的, ownerId: 我id } })).toBe(1);
    expect((await p.customer.findUniqueOrThrow({ where: { id: id.老板的 } })).salesOwnerId).toBe(老板id);
  } finally {
    await p.$disconnect();
  }
});

test("业务员、关掉：回到自己的 + 公海，老板的客户又找不到", async ({ page, request }) => {
  await 设云端团队(request, 团队(false, false));
  await 对齐(page);
  await expect(page.getByRole("tabpanel", { name: /^团队/ })).toContainText("你是业务员：看得到自己负责的客户和公海里的客户");
  await 进门(page, `/customers?keyword=${encodeURIComponent("互看-")}`);
  await expect(page.locator("main").getByRole("link", { name: 名.我的 })).toBeVisible();
  await expect(page.locator("main").getByRole("link", { name: 名.老板的 })).toHaveCount(0);
  await page.goto("/follow-ups");
  await page.waitForLoadState("networkidle").catch(() => {});
  await expect(page.locator("main")).not.toContainText("老板谈的互看价");
  await page.goto(`/customers/${id.老板的}`);
  await expect(page.locator("main")).toContainText("没有找到这条记录");
});

test("老板：设置 → 团队有开关，开 / 关都先弹确认、说清看过导出过的收不回", async ({ page, request }) => {
  await 设云端团队(request, 团队(true, false));
  await 对齐(page);
  const 卡 = page.getByTestId("team-share");
  await expect(卡).toBeVisible();
  await expect(卡).toContainText("已经看过、导出过的收不回");
  const 开关 = 卡.getByRole("switch", { name: "同事之间互相看得到客户" });
  await expect(开关).not.toBeChecked();
  await 卡.scrollIntoViewIfNeeded();
  await 排版没问题(page);

  // 取消：什么也不变
  await 开关.click();
  const 确认 = page.getByTestId("team-share-confirm");
  await expect(确认).toContainText("全队");
  await expect(确认).toContainText("已经看过、导出过的收不回");
  await page.getByRole("button", { name: "取 消" }).or(page.getByRole("button", { name: "取消" })).click();
  await expect(开关).not.toBeChecked();

  await 开关.click();
  await expect(确认).toBeVisible();
  await 截图(page, "1-开关-打开前确认.png");
  await page.getByRole("button", { name: /^打\s*开$/ }).click();
  await expect(page.getByText("已打开：业务员下次同步后看得到全队客户")).toBeVisible();
  await expect(开关).toBeChecked();
  await expect(page.getByRole("tabpanel", { name: /^团队/ })).toContainText("业务员也看得到全队的客户");
  await 卡.scrollIntoViewIfNeeded();
  await 截图(page, "2-开关-已打开.png");

  // 关：确认框说同事的客户会删掉
  await 开关.click();
  await expect(确认).toContainText("会删掉");
  await page.getByRole("button", { name: /^关\s*掉$/ }).click();
  await expect(开关).not.toBeChecked();
});

test("老板：公海里「分配给…」单条分给小周，没做完的活跟过去；撤销回到公海", async ({ page }) => {
  await 进门(page, `/customers?pool=1&keyword=${encodeURIComponent("互看-")}`);
  const 行 = page.getByRole("row", { name: new RegExp(名.公海) });
  await expect(行).toBeVisible();
  await 排版没问题(page);
  await 行.getByRole("button", { name: `分配 ${名.公海} 给…` }).click();
  await page.getByRole("menuitem", { name: 小周 }).click();
  const 提示 = page.locator(".ant-message").getByText(`已把 1 位分给「${小周}」`);
  await expect(提示).toBeVisible();
  // 点的是菜单里的名字，不能顺带点进这一行的记录页
  await expect(page).toHaveURL(/\/customers\?pool=1/);
  await 截图(page, "3-公海-分配后可撤销.png");
  const p = 连库();
  try {
    await expect.poll(async () => (await p.customer.findUniqueOrThrow({ where: { id: id.公海 }, include: { pool: true } }))).toMatchObject({ salesOwnerId: 小周id, pool: null });
    expect((await p.task.findFirstOrThrow({ where: { customerId: id.公海 } })).ownerId).toBe(小周id);
    expect(await p.auditLog.count({ where: { action: "assign", entityId: id.公海 } })).toBe(1);
    await expect(行).toHaveCount(0);

    await page.locator(".ant-message").getByRole("button", { name: /撤\s*销/ }).click();
    await expect(page.getByText("已撤销，1 位改回原样")).toBeVisible();
    await expect.poll(async () => (await p.customer.findUniqueOrThrow({ where: { id: id.公海 }, include: { pool: true } })).salesOwnerId).toBe(老板id);
    expect(await p.customerPool.count({ where: { customerId: id.公海 } })).toBe(1);
    expect((await p.task.findFirstOrThrow({ where: { customerId: id.公海 } })).ownerId).toBe(老板id);
  } finally {
    await p.$disconnect();
  }
});

test("老板：公海批量「分配给…」，批量分配这时不摆", async ({ page }) => {
  await 进门(page, `/customers?pool=1&keyword=${encodeURIComponent("互看-")}`);
  for (const n of [名.公海, 名.公海二]) await page.getByRole("row", { name: new RegExp(n) }).getByRole("checkbox").check();
  await expect(page.getByRole("button", { name: /批量分配/ })).toHaveCount(0);
  await page.getByRole("button", { name: /分配给…/ }).click();
  await expect(page.getByRole("menuitem", { name: 小周 })).toBeVisible();
  await 排版没问题(page);
  await 截图(page, "4-公海-批量分配给.png");
  await page.getByRole("menuitem", { name: 小周 }).click();
  await expect(page.locator(".ant-message").getByText(`已把 2 位分给「${小周}」`)).toBeVisible();
  const p = 连库();
  try {
    await expect.poll(async () => p.customer.count({ where: { id: { in: [id.公海, id.公海二] }, salesOwnerId: 小周id, pool: null } })).toBe(2);
  } finally {
    await p.$disconnect();
  }
});
