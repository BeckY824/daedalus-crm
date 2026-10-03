/**
 * 删客户（2026-10-02 排查 B1）：先照实数清会一起删掉什么，联系人不跟着删、搬进未归属。
 * 和那条「删联系人，联系人页也没了」是同一类：人还是那个人，客户档案没了不等于这个人没了。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { deleteCustomers, 删除前清点 } from "@/app/(app)/customers/actions";

let 张三: { id: string };

beforeEach(async () => {
  await resetDb();
  const u = await prisma.user.create({ data: { email: "a@x", name: "甲", title: "管理员", role: "ADMIN", password: "x" } });
  mocks.user.id = u.id;
  张三 = await prisma.customer.create({ data: { name: "张三", phone: "13800000001", salesOwnerId: u.id } });
  await prisma.contact.create({ data: { customerId: 张三.id, name: "张妈妈", phone: "13900000001", isPrimary: true } });
  await prisma.followUp.create({ data: { customerId: 张三.id, ownerId: u.id, type: "CALL", title: "电话", content: "聊了", status: "已完成", occurredAt: new Date() } });
  await prisma.opportunity.create({ data: { customerId: 张三.id, ownerId: u.id, name: "暑期班", amount: 5000, stage: "初步接洽" } });
  await prisma.task.create({ data: { customerId: 张三.id, ownerId: u.id, title: "发资料" } });
  await prisma.contract.create({ data: { customerId: 张三.id, amount: 12000, signedAt: new Date() } });
  await prisma.lead.create({ data: { name: "张三线索", phone: "13800000001", ownerId: u.id, customerId: 张三.id, status: "已转化" } });
});

afterAll(async () => { await prisma.$disconnect(); });

describe("B1 删客户", () => {
  it("删之前数清楚：会删掉什么、什么留下", async () => {
    expect(await 删除前清点([张三.id])).toEqual({
      跟进: 1, 商机: 1, 计划和待办: 1, 签约: 1, 签约金额: [{ 币种: "CNY", 合计: 12000 }], 联系人: 1, 线索: 1,
    });
  });

  it("联系人不跟着删：搬进未归属，记着原来是谁的", async () => {
    const r = await deleteCustomers([张三.id]);
    expect(r).toMatchObject({ ok: true, deleted: 1, 留下联系人: 1 });
    expect(await prisma.customer.count()).toBe(0);
    expect(await prisma.contact.count()).toBe(0);
    expect(await prisma.unassignedContact.findFirstOrThrow()).toMatchObject({
      name: "张妈妈", phone: "13900000001", fromCustomerId: 张三.id, fromCustomerName: "张三",
    });
    // 其余照旧随客户删掉
    expect(await prisma.followUp.count()).toBe(0);
    expect(await prisma.contract.count()).toBe(0);
  });
});
