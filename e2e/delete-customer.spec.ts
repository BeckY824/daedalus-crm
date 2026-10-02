/**
 * 删客户（2026-10-02 排查 B1）：确认框照实列出会一起删掉什么，有签约的先勾一下才能删，
 * 联系人不跟着删、留在联系人页写「未归属」。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库, 清空业务数据 } from "./mock-data";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };

async function 登录(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("用户名").fill(账号.用户名);
  await page.getByPlaceholder("登录密码").fill(账号.密码);
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await page.waitForURL(/\/dashboard/);
}

test.describe.configure({ mode: "serial", timeout: 90_000 });

test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  const 张三 = await p.user.findFirstOrThrow({ where: { email: 账号.用户名 } });
  const c = await p.customer.create({ data: { name: "删除测试甲", phone: "13822220001", salesOwnerId: 张三.id } });
  await p.contact.create({ data: { customerId: c.id, name: "甲的妈妈", phone: "13922220001" } });
  await p.followUp.create({ data: { customerId: c.id, ownerId: 张三.id, type: "CALL", title: "电话", content: "聊了", status: "已完成", occurredAt: new Date() } });
  await p.contract.create({ data: { customerId: c.id, amount: 8800, signedAt: new Date() } });
  await p.$disconnect();
});

test.afterAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await p.$disconnect();
});

test("确认框列出会一起删掉的东西；有签约要先勾一下；联系人留在联系人页", async ({ page }) => {
  await 登录(page);
  await page.goto("/customers");
  await page.getByRole("button", { name: "删除 删除测试甲" }).click();

  const 框 = page.getByRole("dialog");
  await expect(框).toContainText("1 条跟进记录");
  await expect(框).toContainText("1 笔签约");
  await expect(框).toContainText("8,800");
  await expect(框).toContainText("1 位联系人不删");
  await expect(框).toContainText("删除后不能恢复");

  const 删 = 框.getByRole("button", { name: /删\s*除/ });
  await expect(删).toBeDisabled();
  await 框.getByText("我知道签约也会删掉").click();
  await expect(删).toBeEnabled();
  await 删.click();

  await expect(page.locator(".ant-message")).toContainText("1 位联系人留在联系人页");
  await expect(page.locator("tr.ant-table-row", { hasText: "删除测试甲" })).toHaveCount(0);

  await page.goto("/contacts");
  const 行 = page.locator("tr.ant-table-row", { hasText: "甲的妈妈" });
  await expect(行).toContainText("未归属");
});
