/**
 * 团队版业务主管（2026-10-20，客户「硕诚包装」：老板 → 业务主管 → 业务员）。
 *
 * 接着 09 / 09a 造的那台：.team.json 一放，「我」按假云端的名单（中继的 SyncMember.role）对成老板、主管或业务员。
 *   - 老板：成员行有「老板 / 业务主管 / 业务员」标签，能把业务员设成主管（先确认）、也能改回
 *   - 主管：看得到全队（「互相看得到」开关关着也看得到），同事的客户不是只读，公海里能「分配给…」；
 *     邀请码、开关、移除、设角色都没有
 *   - 改回业务员：回到自己的 + 公海
 * 窗口用桌面端最窄（1024 × 700），名字故意很长，每一屏量一次排版。SHOT_DIR 给了就截几张（PR 用）。
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
  老板的: "主管-老板的客户·东莞市硕诚包装材料有限公司华南采购部",
  我的: "主管-我的客户",
  公海: "主管-公海客户·佛山顺德彩印纸箱厂",
};
const 小周 = "小周·华东区域业务经理（新人）";
const id: Record<string, string> = {};
/** 我是谁：老板 / 主管 / 业务员（假云端的名单就是中继的 SyncMember.role） */
type 我 = "owner" | "manager" | "member";
const 成员 = (我: 我) => [
  // 我是老板时这一位是业务员，换个名字，截图里不出现「王老板 · 业务员」
  { accountId: "acc_boss", name: 我 === "owner" ? "陈业务·华南区域客户经理" : "王老板", contact: "boss@e2e.local", role: 我 === "owner" ? "member" : "owner" },
  { accountId: 云端账号.id, name: 云端账号.name, contact: 云端账号.contact, role: 我 },
  { accountId: "acc_zhou", name: 小周, contact: "zhou@e2e.local", role: "member" },
];
const 团队 = (我: 我) => ({ id: "t_e2e", name: "E2E 团队", active: true, 我是建的人: 我 === "owner", 互看: false, 成员: 成员(我) });
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
/** 设置 → 团队打开一次 = 按名单对角色；限定有 3 秒缓存，等它过期 */
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
    id.老板的 = (await p.customer.create({ data: { name: 名.老板的, phone: "13600000201", salesOwnerId: 老板id } })).id;
    id.我的 = (await p.customer.create({ data: { name: 名.我的, phone: "13600000202", salesOwnerId: 我id } })).id;
    id.公海 = (await p.customer.create({ data: { name: 名.公海, phone: "13600000203", salesOwnerId: 老板id } })).id;
    await p.customerPool.create({ data: { customerId: id.公海, reason: "手动" } });
    await p.followUp.create({ data: { customerId: id.老板的, ownerId: 老板id, type: "CALL", title: "电话", content: "老板谈的纸箱报价", status: "已完成", occurredAt: new Date() } });
  } finally {
    await p.$disconnect();
  }
  await 设云端团队(request, 团队("owner"));
  writeFileSync(
    path.join(DATA_DIR, ".team.json"),
    JSON.stringify({ teamId: "t_e2e", teamName: "E2E 团队", joinSecret: "e2e", key: "A".repeat(43), device: "dev_e2e", pulled: 0 }),
    { mode: 0o600 },
  );
});

test.afterAll(async ({ request }) => {
  rmSync(path.join(DATA_DIR, ".team.json"), { force: true });
  // 假云端的名单还原成 09 留下的样子（我是业务员、没有互看），后面几组看到的和没有这一组时一样
  await 设云端团队(request, { id: "t_e2e", name: "E2E 团队", active: true, 我是建的人: false, 成员: 成员("member").slice(0, 2) });
  const p = 连库();
  try {
    await p.customer.deleteMany({ where: { id: { in: Object.values(id) } } });
    await p.user.update({ where: { id: 我id }, data: { role: "ADMIN", active: true } });
    await p.user.updateMany({ where: { id: { not: 我id } }, data: { active: false } });
  } finally {
    await p.$disconnect();
  }
});

const 成员行 = (page: Page, 名字: string) => page.getByRole("tabpanel", { name: /^团队/ }).locator(".team-members li").filter({ hasText: 名字 });

test("老板：成员行有老板 / 业务员标签；把小周设成主管先确认，标签和说明跟着变；也能改回", async ({ page }) => {
  await 对齐(page);
  const 栏 = page.getByRole("tabpanel", { name: /^团队/ });
  await expect(page.getByTestId("team-role-intro")).toContainText("你是老板");
  await expect(page.getByTestId("team-role-intro")).toContainText("业务主管看得到全队");
  await expect(成员行(page, 云端账号.name).locator(".ant-tag")).toHaveText("老板");
  await expect(成员行(page, 小周).locator(".ant-tag")).toHaveText("业务员");
  // 自己那一行不摆
  await expect(成员行(page, 云端账号.name).getByRole("button", { name: /设为主管|改回业务员/ })).toHaveCount(0);
  await 栏.locator(".team-members").scrollIntoViewIfNeeded();
  await 排版没问题(page);

  await page.getByRole("button", { name: `设为主管 ${小周}` }).click();
  const 确认 = page.getByTestId("team-role-confirm");
  await expect(确认).toContainText("全队");
  await expect(确认).toContainText("加人、移除成员、看邀请码、改业务配置");
  await 截图(page, "5-主管-设为主管确认.png");
  await page.getByRole("button", { name: /^设为主管$/ }).click();
  await expect(page.getByText(`「${小周}」现在是业务主管`)).toBeVisible();
  await expect(成员行(page, 小周).locator(".ant-tag")).toHaveText("业务主管");
  await expect(page.getByRole("button", { name: `改回业务员 ${小周}` })).toBeVisible();
  await 栏.locator(".team-members").scrollIntoViewIfNeeded();
  await 排版没问题(page);
  await 截图(page, "6-主管-成员行标签.png");

  await page.getByRole("button", { name: `改回业务员 ${小周}` }).click();
  await expect(确认).toContainText("收不回");
  await page.getByRole("button", { name: /^改回业务员$/ }).click();
  await expect(成员行(page, 小周).locator(".ant-tag")).toHaveText("业务员");
});

test("主管：开关关着也看得到全队、同事的客户能改、公海能分配；邀请码、开关、移除、设角色都没有", async ({ page, request }) => {
  await 设云端团队(request, 团队("manager"));
  await 对齐(page);
  const 栏 = page.getByRole("tabpanel", { name: /^团队/ });
  await expect(page.getByTestId("team-role-intro")).toContainText("你是业务主管：看得到全队的客户和跟进");
  await expect(成员行(page, 云端账号.name).locator(".ant-tag")).toHaveText("业务主管");
  await expect(page.getByTestId("team-share")).toHaveCount(0);
  await expect(栏.getByRole("button", { name: /设为主管|改回业务员|^移除/ })).toHaveCount(0);
  await expect(栏.getByRole("textbox", { name: "邀请码" })).toHaveCount(0);
  await expect(栏).toContainText("要加人找老板（建团队的人）要邀请码");
  // 看全队：每个人的客户数、跟进也给主管
  await expect(成员行(page, "王老板")).toContainText("近 7 天跟进");
  await 排版没问题(page);
  await 截图(page, "7-主管-设置团队.png");
  const p = 连库();
  try {
    expect((await p.user.findUniqueOrThrow({ where: { id: 我id } })).role).toBe("MANAGER");
  } finally {
    await p.$disconnect();
  }

  await 进门(page, `/customers?keyword=${encodeURIComponent("主管-")}`);
  await expect(page.locator("main").getByRole("link", { name: 名.老板的 })).toBeVisible();
  await expect(page.locator("main").getByRole("link", { name: 名.我的 })).toBeVisible();
  await 排版没问题(page);
  await page.goto("/follow-ups");
  await expect(page.locator("main")).toContainText("老板谈的纸箱报价");

  // 同事的客户不是只读：没有只读横条，能编辑
  await 进门(page, `/customers/${id.老板的}`);
  await expect(page.getByRole("heading", { name: 名.老板的 })).toBeVisible();
  await expect(page.locator(".rec-readonly")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /编辑全部/ })).toBeVisible();

  // 公海：能「分配给…」小周，撤销
  await 进门(page, `/customers?pool=1&keyword=${encodeURIComponent("主管-")}`);
  const 行 = page.getByRole("row", { name: new RegExp(名.公海) });
  await 行.getByRole("button", { name: `分配 ${名.公海} 给…` }).click();
  await page.getByRole("menuitem", { name: 小周 }).click();
  await expect(page.locator(".ant-message").getByText(`已把 1 位分给「${小周}」`)).toBeVisible();
  await page.locator(".ant-message").getByRole("button", { name: /撤\s*销/ }).click();
  await expect(page.getByText("已撤销，1 位改回原样")).toBeVisible();
  const q = 连库();
  try {
    await expect.poll(async () => q.customerPool.count({ where: { customerId: id.公海 } })).toBe(1);
  } finally {
    await q.$disconnect();
  }
});

test("改回业务员：本机角色回 SALES，老板的客户又找不到、公海没有「分配给…」", async ({ page, request }) => {
  await 设云端团队(request, 团队("member"));
  await 对齐(page);
  await expect(page.getByTestId("team-role-intro")).toContainText("你是业务员");
  await 进门(page, `/customers?keyword=${encodeURIComponent("主管-")}`);
  await expect(page.locator("main").getByRole("link", { name: 名.我的 })).toBeVisible();
  await expect(page.locator("main").getByRole("link", { name: 名.老板的 })).toHaveCount(0);
  await 进门(page, `/customers?pool=1&keyword=${encodeURIComponent("主管-")}`);
  await expect(page.locator("main").getByRole("link", { name: 名.公海 })).toBeVisible();
  await expect(page.getByRole("button", { name: /^分配 .* 给…$/ })).toHaveCount(0);
});
