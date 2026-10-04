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

/**
 * 2026-10-04 上线前测试第 1 期：批量删客户。之前所有用例都只传 1 个 id，
 * 而列表页多选删除走的就是这一条——一次删几位时联系人、子表、别的客户是不是都对，从来没钉过。
 */
describe("批量删多位客户", () => {
  async function 造(名: string, 号: string, 联系人数: number) {
    const c = await prisma.customer.create({ data: { name: 名, phone: 号, salesOwnerId: mocks.user.id } });
    for (let i = 0; i < 联系人数; i++) {
      await prisma.contact.create({ data: { customerId: c.id, name: `${名}的联系人${i + 1}`, phone: `139${号.slice(3, 10)}${i}`.slice(0, 11) } });
    }
    await prisma.followUp.create({ data: { customerId: c.id, ownerId: mocks.user.id, type: "CALL", title: "电话", content: "聊了", status: "已完成", occurredAt: new Date() } });
    await prisma.opportunity.create({ data: { customerId: c.id, ownerId: mocks.user.id, name: `${名}的商机`, amount: 1000, stage: "初步接洽" } });
    await prisma.task.create({ data: { customerId: c.id, ownerId: mocks.user.id, title: `给${名}发资料` } });
    return c;
  }

  it("一次删三位：联系人全进未归属、各自记着原来是谁的；子表清干净；没选中的那位一点不动", async () => {
    const 李四 = await 造("李四", "13800000002", 2);
    const 王五 = await 造("王五", "13800000003", 0);
    const 赵六 = await 造("赵六", "13800000004", 1);
    const 留着 = await 造("留着", "13800000005", 1);

    const 清点 = await 删除前清点([张三.id, 李四.id, 王五.id]);
    expect(清点).toMatchObject({ 跟进: 3, 商机: 3, 计划和待办: 3, 签约: 1, 联系人: 3 });

    const r = await deleteCustomers([张三.id, 李四.id, 王五.id]);
    expect(r).toMatchObject({ ok: true, deleted: 3, 留下联系人: 3 });

    const 剩下 = await prisma.customer.findMany({ select: { name: true }, orderBy: { name: "asc" } });
    expect(剩下.map((c) => c.name).sort()).toEqual(["留着", "赵六"].sort());

    const 未归属 = await prisma.unassignedContact.findMany({ orderBy: { name: "asc" } });
    expect(未归属.map((u) => [u.name, u.fromCustomerName])).toEqual(
      [["张妈妈", "张三"], ["李四的联系人1", "李四"], ["李四的联系人2", "李四"]].sort((a, b) => a[0].localeCompare(b[0])),
    );
    expect(未归属.find((u) => u.fromCustomerName === "李四")?.fromCustomerId).toBe(李四.id);

    // 删掉的三位：子表一条不剩；没选中的两位：一条不少
    for (const id of [张三.id, 李四.id, 王五.id]) {
      expect(await prisma.followUp.count({ where: { customerId: id } })).toBe(0);
      expect(await prisma.opportunity.count({ where: { customerId: id } })).toBe(0);
      expect(await prisma.task.count({ where: { customerId: id } })).toBe(0);
      expect(await prisma.contract.count({ where: { customerId: id } })).toBe(0);
    }
    for (const c of [赵六, 留着]) {
      expect(await prisma.contact.count({ where: { customerId: c.id } })).toBe(1);
      expect(await prisma.followUp.count({ where: { customerId: c.id } })).toBe(1);
      expect(await prisma.opportunity.count({ where: { customerId: c.id } })).toBe(1);
      expect(await prisma.task.count({ where: { customerId: c.id } })).toBe(1);
    }
    // 线索不跟着删，只是解绑
    expect(await prisma.lead.findFirstOrThrow({ where: { name: "张三线索" } })).toMatchObject({ customerId: null });
  });

  it("选中的里有一位是别人的推荐人：整批不删，一位都不动", async () => {
    const 李四 = await 造("李四", "13800000002", 1);
    const 被推荐 = await prisma.customer.create({ data: { name: "被推荐的", phone: "13800000009", salesOwnerId: mocks.user.id, referrerCustomerId: 李四.id } });
    const r = await deleteCustomers([张三.id, 李四.id]);
    expect(r.ok).toBe(false);
    expect(await prisma.customer.count({ where: { id: { in: [张三.id, 李四.id, 被推荐.id] } } })).toBe(3);
    expect(await prisma.contact.count()).toBe(2);
    expect(await prisma.unassignedContact.count()).toBe(0);
  });
});

