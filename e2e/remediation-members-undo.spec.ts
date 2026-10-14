import { test, expect, type Page } from "@playwright/test";
import { 连库 } from "./mock-data";
async function login(page: Page) {
  await page.goto("/login"); await page.getByPlaceholder("用户名").fill("admin"); await page.getByPlaceholder("登录密码").fill("admin123");
  await page.getByRole("button", { name: /登\s*录/ }).click(); await page.waitForURL(/\/dashboard/);
}
test("T-038/T-039 成员编辑冲突与恢复失败在界面如实提示", async ({ page }) => {
  const db = 连库(); let id = "";
  try {
    id = (await db.user.create({ data: { name: "QA成员失败提示", email: "qa-ui-member", password: "unused", role: "SALES", active: false } })).id;
    await login(page); await page.goto("/settings"); await page.getByRole("tab", { name: "团队成员" }).click();
    const row = page.getByRole("row").filter({ hasText: "QA成员失败提示" });
    await row.getByRole("button", { name: "edit", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "编辑成员 · QA成员失败提示" });
    await dialog.getByLabel("登录用户名", { exact: true }).fill("admin");
    await dialog.getByRole("button", { name: /保\s*存/ }).click();
    await expect(page.getByText("该登录用户名已被占用")).toBeVisible(); await expect(dialog).toBeVisible();
    expect((await db.user.findUniqueOrThrow({ where: { id } })).email).toBe("qa-ui-member");
    await dialog.getByRole("button", { name: /取\s*消/ }).click();
    await db.user.delete({ where: { id } }); id = "";
    await row.getByRole("button", { name: "恢复成员 QA成员失败提示" }).click();
    await expect(page.getByText("这个成员已不存在，请刷新重试")).toBeVisible();
    await expect(page.getByText("已恢复", { exact: true })).toHaveCount(0);
  } finally { if (id) await db.user.delete({ where: { id } }); await db.$disconnect(); }
});
test("J-094 管道撤销只执行一次，旧撤销不能盖掉后续编辑", async ({ page }) => {
  const db = 连库(); let customerId = "";
  try {
    const owner = await db.user.findFirstOrThrow({ where: { active: true, role: { not: "ADMIN" } } });
    customerId = (await db.customer.create({ data: { name: "QA撤销客户", phone: "", salesOwnerId: owner.id } })).id;
    const opp = await db.opportunity.create({ data: { name: "QA撤销商机", customerId, ownerId: owner.id, amount: 100, stage: "方案报价", status: "OPEN", probability: 75 } });
    await login(page); await page.goto("/opportunities/pipeline");
    const card = page.getByRole("button", { name: /^QA撤销商机，/ });
    const advance = async () => {
      const item = page.getByRole("menuitem", { name: "推进到 谈判审核", exact: true });
      // 右键菜单本身不写库；等客户端菜单可交互后，推进动作只执行一次。
      await expect(async () => {
        if (!(await item.isVisible())) await card.click({ button: "right" });
        await expect(item).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 20_000 });
      await item.click();
      await expect(page.locator(".ant-message")).toContainText("已推进到");
    };
    await advance();
    await page.locator(".ant-message").getByRole("button", { name: "撤销" }).dblclick();
    await expect.poll(async () => (await db.opportunity.findUniqueOrThrow({ where: { id: opp.id } })).stage).toBe("方案报价");
    await expect(page.locator(".ant-message").getByRole("button", { name: "撤销" })).toHaveCount(0);
    expect(await db.auditLog.count({ where: { entity: "Opportunity", entityId: opp.id } })).toBe(2);
    await advance();
    const now = await db.opportunity.findUniqueOrThrow({ where: { id: opp.id } });
    await db.opportunity.update({ where: { id: opp.id }, data: { stage: "需求确认", updatedAt: new Date(now.updatedAt.getTime() + 1_000) } });
    await page.locator(".ant-message").getByRole("button", { name: "撤销" }).click();
    await expect(page.getByText("商机后来又变过了，不能撤销旧操作，请查看最新内容")).toBeVisible();
    expect((await db.opportunity.findUniqueOrThrow({ where: { id: opp.id } })).stage).toBe("需求确认");
    expect(await db.auditLog.count({ where: { entity: "Opportunity", entityId: opp.id } })).toBe(3);
  } finally { if (customerId) await db.customer.delete({ where: { id: customerId } }); await db.$disconnect(); }
});
