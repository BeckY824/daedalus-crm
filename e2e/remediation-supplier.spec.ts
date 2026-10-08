import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { 连库 } from "./mock-data";

async function preset(page: Page, name: string) {
  await page.goto("/settings");
  await page.getByRole("tab", { name: "业务配置" }).click();
  const panel = page.getByRole("tabpanel", { name: "业务配置" });
  await panel.getByRole("button", { name, exact: true }).click();
  await panel.locator(".biz-preset-todo").getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText("已保存，全站措辞已更新")).toBeVisible();
}

test("W-049 同名供应商候选选择不同ID，编辑和清空后实际引用正确", async ({ page }) => {
  test.setTimeout(120_000);
  const db = 连库();
  const suppliers: { id: string; name: string }[] = [];
  let customerId = "";
  try {
    const owner = await db.user.findFirstOrThrow({ where: { active: true, role: { not: "ADMIN" } } });
    const customer = await db.customer.create({ data: { name: "QA-同名供应商界面", phone: "", salesOwnerId: owner.id } });
    customerId = customer.id;
    for (let i = 0; i < 2; i++) suppliers.push(await db.supplier.create({ data: { name: "QA-重名工厂" } }));
    const k = await db.contract.create({ data: { customerId, amount: 100, signedAt: new Date() } });
    await db.contractMoney.create({ data: { contractId: k.id, amountExact: 100, currency: "USD" } });
    const order = await db.tradeOrder.create({ data: { no: "QA-SUPPLIER-UI", customerId, contractId: k.id, ownerId: owner.id, amount: 100, currency: "USD", purchase: { create: { supplierId: suppliers[1].id } } } });
    await page.goto("/login");
    await page.getByPlaceholder("用户名").fill("admin");
    await page.getByPlaceholder("登录密码").fill("admin123");
    await page.getByRole("button", { name: /登\s*录/ }).click();
    await page.waitForURL(/\/dashboard/);
    await preset(page, "外贸出口");
    await page.goto(`/customers/${customerId}`);
    const edit = async () => {
      await page.getByRole("link", { name: "QA-SUPPLIER-UI", exact: true }).hover();
      await page.getByRole("button", { name: "编辑订单 QA-SUPPLIER-UI", exact: true }).click();
    };
    for (const target of [suppliers[0], suppliers[1]]) {
      await edit();
      const dialog = page.getByRole("dialog", { name: "编辑订单" });
      await dialog.getByLabel("供应商", { exact: true }).click();
      const option = page.locator(".ant-select-item-option-content").filter({ hasText: `QA-重名工厂（${target.id.slice(-6)}）` });
      await expect(option).toBeVisible();
      await option.click();
      await expect(dialog.getByLabel("供应商", { exact: true })).toHaveValue("QA-重名工厂");
      await dialog.getByRole("button", { name: /保\s*存/ }).click();
      await expect(dialog).toBeHidden();
      await expect.poll(async () => (await db.tradeOrderPurchase.findUniqueOrThrow({ where: { orderId: order.id } })).supplierId).toBe(target.id);
    }
    await edit();
    const dialog = page.getByRole("dialog", { name: "编辑订单" });
    await dialog.getByLabel("备注", { exact: true }).fill("QA-只改备注保留绑定");
    await dialog.getByRole("button", { name: /保\s*存/ }).click();
    await expect(dialog).toBeHidden();
    expect((await db.tradeOrderPurchase.findUniqueOrThrow({ where: { orderId: order.id } })).supplierId).toBe(suppliers[1].id);
    await page.screenshot({ path: path.resolve("../测试证据-2026-10-08/整改-W049-同名供应商界面.png"), fullPage: true });
    await edit();
    await dialog.getByLabel("供应商", { exact: true }).fill("");
    await dialog.getByRole("button", { name: /保\s*存/ }).click();
    await expect(dialog).toBeHidden();
    expect((await db.tradeOrderPurchase.findUniqueOrThrow({ where: { orderId: order.id } })).supplierId).toBeNull();
  } finally {
    try {
      if (!page.isClosed() && page.url().includes("/customers/")) await preset(page, "通用销售");
    } finally {
      if (customerId) await db.customer.delete({ where: { id: customerId } });
      await db.supplier.deleteMany({ where: { id: { in: suppliers.map((s) => s.id) } } });
      await db.$disconnect();
    }
  }
});
