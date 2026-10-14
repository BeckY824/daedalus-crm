import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import path from "node:path";
import { 连库 } from "./mock-data";
import { 配好AI, 拆掉假模型 } from "./fake-llm";

test("J-177 AI组合保存故障整体回滚，原表单重试后所有项一并完成", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const db = 连库();
  const gateway = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ followUp: { type: "PHONE", title: "QA事务测试", content: "QA已确认报价，需要发报价和下次回访", status: "已完成", occurredAt: null, contactId: null, opportunityId: null }, tasks: [{ title: "QA发报价", dueAt: "2026-10-10 10:00" }], plan: { subject: "QA下一次回访", plannedAt: "2026-10-11 10:00", method: "电话沟通" } }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  let customerId = "";
  try {
    const owner = await db.user.findFirstOrThrow({ where: { active: true, role: { not: "ADMIN" } } });
    customerId = (await db.customer.create({ data: { name: "QA原子跟进", phone: "", salesOwnerId: owner.id } })).id;
    const old = await db.followPlan.create({ data: { customerId, ownerId: owner.id, subject: "QA到期收尾", method: "电话沟通", plannedAt: new Date("2026-10-01") } });
    await page.goto("/login");
    await page.getByPlaceholder("用户名").fill("admin"); await page.getByPlaceholder("登录密码").fill("admin123");
    await page.getByRole("button", { name: /登\s*录/ }).click(); await page.waitForURL(/\/dashboard/);
    const address = gateway.address();
    if (!address || typeof address === "string") throw new Error("QA gateway address missing");
    await 配好AI(page, `http://127.0.0.1:${address.port}/v1`);
    await page.goto(`/customers/${customerId}`);
    await page.getByRole("button", { name: "记录跟进", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建跟进" });
    await dialog.getByPlaceholder(/跟进速记/).fill("QA已确认报价，我明天发报价，后天再打电话回访。");
    await dialog.getByRole("button", { name: /AI 解析填表/ }).click();
    await expect(dialog.getByText(/同时创建下次跟进计划：QA下一次回访/)).toBeVisible();
    await expect(dialog.getByText(/同时完成计划「QA到期收尾」/)).toBeVisible();
    await db.$executeRawUnsafe("CREATE TRIGGER qa_ui_task_failure BEFORE INSERT ON Task BEGIN SELECT RAISE(ABORT, 'QA task unavailable'); END");
    try {
      await dialog.getByRole("button", { name: /保\s*存/ }).click();
      // SQLite触发器故障被Prisma归为P2003，服务端会返回关联对象不可用提示。
      await expect(page.getByText("关联数据已变化，或仍有其他记录依赖它；这次操作未完成，请刷新核对关联记录后重试")).toBeVisible();
      await expect(dialog).toBeVisible();
      expect(await db.followUp.count({ where: { customerId } })).toBe(0);
      expect(await db.task.count({ where: { customerId } })).toBe(0);
      expect(await db.followPlan.count({ where: { customerId } })).toBe(1);
      expect((await db.followPlan.findUniqueOrThrow({ where: { id: old.id } })).done).toBe(false);
      await page.screenshot({ path: path.resolve("../测试证据-2026-10-08/整改-J177-故障保留表单.png"), fullPage: true });
    } finally { await db.$executeRawUnsafe("DROP TRIGGER qa_ui_task_failure"); }
    await dialog.getByRole("button", { name: /保\s*存/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".ant-message")).toContainText("一并完成");
    expect(await db.followUp.count({ where: { customerId } })).toBe(1);
    expect(await db.task.count({ where: { customerId } })).toBe(1);
    expect(await db.followPlan.count({ where: { customerId } })).toBe(2);
    expect((await db.followPlan.findUniqueOrThrow({ where: { id: old.id } })).done).toBe(true);
  } finally {
    try { await 拆掉假模型(browser); } finally {
      if (customerId) await db.customer.delete({ where: { id: customerId } });
      await db.$disconnect();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  }
});
