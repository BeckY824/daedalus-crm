/**
 * 删客户（2026-10-02 排查 B1）在桌面端：确认框照实列出会一起删掉的东西，有签约的先勾一下才能删，
 * 联系人不跟着删、留在联系人页写「未归属」。数据直接写库造（造的是「已经在那儿的客户」，不是要测的流程）。
 */
import { test, expect } from "@playwright/test";
import { 我的id, 连库, 进门 } from "./helpers";

test.describe.configure({ mode: "serial" });

const 名 = "桌面删除甲";

test.beforeAll(async () => {
  const p = 连库();
  try {
    const 我 = await 我的id(p);
    const c = await p.customer.create({ data: { name: 名, phone: "13822229901", salesOwnerId: 我 } });
    await p.contact.create({ data: { customerId: c.id, name: "甲的采购", phone: "13922229901" } });
    await p.followUp.create({ data: { customerId: c.id, ownerId: 我, type: "CALL", title: "电话", content: "聊了", status: "已完成", occurredAt: new Date() } });
    await p.contract.create({ data: { customerId: c.id, amount: 8800, signedAt: new Date() } });
  } finally {
    await p.$disconnect();
  }
});

test("删客户：确认框列出一起删的跟进和签约，签约要先勾；联系人进「未归属」", async ({ page }) => {
  await 进门(page, "/customers");
  await page.getByRole("button", { name: `删除 ${名}` }).click();

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
  await expect(page.locator("tr.ant-table-row", { hasText: 名 })).toHaveCount(0);

  await page.goto("/contacts");
  await expect(page.locator("tr.ant-table-row", { hasText: "甲的采购" })).toContainText("未归属");

  // 库里也确实删了：跟进、签约跟着走，联系人挪进未归属
  const p = 连库();
  try {
    expect(await p.customer.count({ where: { name: 名 } })).toBe(0);
    expect(await p.unassignedContact.count({ where: { name: "甲的采购" } })).toBe(1);
  } finally {
    await p.$disconnect();
  }
});
