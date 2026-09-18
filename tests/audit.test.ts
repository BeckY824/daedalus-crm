/**
 * 操作留痕。
 *
 * 「全员可见可改」这个决策成立的前提就是有据可查，所以这组用例盯两件事：
 *   1. 该记的都记了，而且记的内容人能看懂
 *   2. 记录本身足够结实——成员被删也不该带走历史，写日志失败也不该拖垮业务
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { saveCustomer, deleteCustomers, saveContract, assignSalesOwner } from "@/app/(app)/customers/actions";
import { saveOpportunity, moveStage, setOppStatus, deleteOpportunities } from "@/app/(app)/opportunities/actions";
import {
  saveFollowUp, deleteFollowUp, saveTask, toggleTask, deleteTask,
  savePlan, completePlan, saveContact, deleteContact,
} from "@/app/(app)/customers/[id]/actions";
import { saveLead } from "@/app/(app)/leads/actions";
import { recordAudit } from "@/lib/audit";

let jia: { id: string };
let yi: { id: string };

beforeEach(async () => {
  await resetDb();
  jia = await prisma.user.create({ data: { email: "jia", name: "甲", title: "销售", role: "ADMIN", password: "x" } });
  yi = await prisma.user.create({ data: { email: "yi", name: "乙", title: "销售", role: "SALES", password: "x" } });
  mocks.user = { id: jia.id, name: "甲", email: "jia", role: "ADMIN", title: "管理员", avatar: null };
});

afterAll(async () => { await prisma.$disconnect(); });

async function 建一个(name = "学员", phone = "13800000001") {
  const r = await saveCustomer({
    name, phone, school: null, grade: null, major: null,
    followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null,
    remark: null, salesOwnerId: jia.id, channelId: null, referrerCustomerId: null,
  });
  if (!r.ok) throw new Error(r.error);
  return r.id;
}

async function 最新日志() {
  return prisma.auditLog.findFirstOrThrow({ orderBy: { at: "desc" } });
}

describe("该记的都记了", () => {
  it("新建学员留下一条能读懂的记录", async () => {
    await 建一个("张三");
    const log = await 最新日志();
    expect(log.action).toBe("create");
    expect(log.entity).toBe("Customer");
    expect(log.summary).toContain("张三");
    expect(log.userName).toBe("甲");
  });

  it("修改客户要记下改了哪几项、前后各是什么", async () => {
    const id = await 建一个("张三");
    const 行 = await prisma.customer.findUniqueOrThrow({ where: { id } });
    const base = {
      name: 行.name, phone: 行.phone, school: 行.school, grade: 行.grade, major: 行.major,
      followStatus: 行.followStatus, decisionStatus: 行.decisionStatus,
      expectedSignAt: 行.expectedSignAt, remark: 行.remark, salesOwnerId: 行.salesOwnerId,
      channelId: 行.channelId, referrerCustomerId: 行.referrerCustomerId,
    };
    await saveCustomer({
      id, updatedAt: 行.updatedAt.toISOString(), base,
      ...base, school: "星辰科技", followStatus: "意向较高",
    } as Parameters<typeof saveCustomer>[0]);

    const log = await 最新日志();
    expect(log.action).toBe("update");
    expect(log.summary).toContain("公司");
    expect(log.summary).toContain("跟进状态");

    const detail = JSON.parse(log.detail!) as { 字段: string; 原值: string; 新值: string }[];
    const 公司 = detail.find((d) => d.字段 === "公司");
    expect(公司?.原值).toBe("（空）");
    expect(公司?.新值).toBe("星辰科技");
  });

  it("删除学员要在删之前把名字留下来", async () => {
    const id = await 建一个("要删的", "13800000002");
    await deleteCustomers([id]);
    const log = await 最新日志();
    expect(log.action).toBe("delete");
    expect(log.summary).toContain("要删的");
  });

  it("批量转派记录实际影响的条数和目标负责人", async () => {
    const a = await 建一个("甲的", "13800000003");
    const b = await 建一个("乙的", "13800000004");
    await assignSalesOwner([a, b], yi.id);
    const log = await 最新日志();
    expect(log.action).toBe("assign");
    expect(log.summary).toContain("2 名客户");
    expect(log.summary).toContain("乙");
  });

  it("登记签约要记金额；确认过重复的那次要标出来", async () => {
    const id = await 建一个("签约的", "13800000005");
    const 今天 = new Date(2026, 7, 29, 10, 0, 0);
    await saveContract({ customerId: id, amount: 19800, signedAt: 今天, remark: null });
    expect((await 最新日志()).summary).toContain("19,800");

    await saveContract({ customerId: id, amount: 19800, signedAt: 今天, remark: null, force: true });
    expect((await 最新日志()).summary).toContain("已确认不是重复录入");
  });

  it("被查重拦下、没真正写进去的那次，不该留下记录", async () => {
    const id = await 建一个("查重的", "13800000006");
    const 今天 = new Date(2026, 7, 29, 10, 0, 0);
    await saveContract({ customerId: id, amount: 19800, signedAt: 今天, remark: null });
    const 之前 = await prisma.auditLog.count();

    const 被拦 = await saveContract({ customerId: id, amount: 19800, signedAt: 今天, remark: null });
    expect(被拦.ok).toBe(false);
    expect(await prisma.auditLog.count()).toBe(之前);
  });

  it("并发合并写入也要留痕，并标明是合并的", async () => {
    const id = await 建一个("被合并的", "13800000007");
    const 行 = await prisma.customer.findUniqueOrThrow({ where: { id } });
    const base = {
      name: 行.name, phone: 行.phone, school: 行.school, grade: 行.grade, major: 行.major,
      followStatus: 行.followStatus, decisionStatus: 行.decisionStatus,
      expectedSignAt: 行.expectedSignAt, remark: 行.remark, salesOwnerId: 行.salesOwnerId,
      channelId: 行.channelId, referrerCustomerId: 行.referrerCustomerId,
    };
    const 甲版本 = 行.updatedAt.toISOString();

    // 乙先改院校
    const 乙行 = await prisma.customer.findUniqueOrThrow({ where: { id } });
    await saveCustomer({
      id, updatedAt: 乙行.updatedAt.toISOString(), base, ...base, school: "星辰科技",
    } as Parameters<typeof saveCustomer>[0]);

    // 甲拿旧版本改行业，走合并路径
    const r = await saveCustomer({
      id, updatedAt: 甲版本, base, ...base, major: "计算机",
    } as Parameters<typeof saveCustomer>[0]);
    expect(r.ok).toBe(true);

    const log = await 最新日志();
    expect(log.summary).toContain("行业");
    expect(log.summary).toContain("自动合并");
  });
});

/**
 * 2026-09-18 补的一组。
 *
 * 在这之前留痕只覆盖客户、合同、渠道、线索删除和成员——**商机和跟进一条都不记**：
 * 在商机里删掉一整条几万块的机会，操作日志里什么都没有。留痕要么覆盖所有写操作，
 * 要么它就不是一个能用来追溯的东西。
 */
describe("商机、跟进、待办、计划、联系人的写操作也要记", () => {
  async function 一个商机(name = "年度采购") {
    const cid = await 建一个("商机的客户", "13800000101");
    const r = await saveOpportunity({
      name, customerId: cid, amount: 50000, stage: "初步沟通", status: "OPEN",
      probability: 20, expectedDealAt: null, remark: null, ownerId: jia.id,
    });
    expect(r.ok).toBe(true);
    const o = await prisma.opportunity.findFirstOrThrow({ where: { name } });
    return { cid, id: o.id };
  }

  it("新建商机记下名字和金额", async () => {
    await 一个商机();
    const log = await 最新日志();
    expect(log.action).toBe("create");
    expect(log.entity).toBe("Opportunity");
    expect(log.summary).toContain("年度采购");
    expect(log.summary).toContain("50000");
  });

  it("换阶段记下从哪到哪", async () => {
    const { id } = await 一个商机();
    await moveStage(id, "方案报价");
    const log = await 最新日志();
    expect(log.summary).toContain("初步沟通");
    expect(log.summary).toContain("方案报价");
  });

  it("标记丢单要写成人话，不是 LOST", async () => {
    const { id } = await 一个商机();
    await setOppStatus(id, "LOST");
    const log = await 最新日志();
    expect(log.summary).toContain("丢单");
    expect(log.summary).not.toContain("LOST");
  });

  it("删商机要在删之前把名字和金额留下来", async () => {
    const { id } = await 一个商机("要删的商机");
    await deleteOpportunities([id]);
    const log = await 最新日志();
    expect(log.action).toBe("delete");
    expect(log.entity).toBe("Opportunity");
    expect(log.summary).toContain("要删的商机");
    expect(log.detail).toContain("要删的商机");
    // 删干净了，日志是唯一还知道它存在过的地方
    expect(await prisma.opportunity.count({ where: { id } })).toBe(0);
  });

  it("记一条跟进、删一条跟进都留痕，且写的是「电话沟通」不是 PHONE", async () => {
    const cid = await 建一个("跟进的客户", "13800000102");
    await saveFollowUp({
      customerId: cid, type: "PHONE", title: null, content: "聊了预算",
      status: "已完成", occurredAt: new Date(2026, 8, 18, 10, 0, 0).toISOString(),
    });
    let log = await 最新日志();
    expect(log.entity).toBe("FollowUp");
    expect(log.summary).toContain("电话沟通");
    expect(log.summary).toContain("跟进的客户");

    const f = await prisma.followUp.findFirstOrThrow({ where: { customerId: cid } });
    await deleteFollowUp(f.id, cid);
    log = await 最新日志();
    expect(log.action).toBe("delete");
    expect(log.detail).toContain("聊了预算"); // 内容跟着一起留下来
  });

  it("待办的增、改状态、删都留痕", async () => {
    const cid = await 建一个("待办的客户", "13800000103");
    await saveTask({ customerId: cid, title: "发报价单", dueAt: null });
    expect((await 最新日志()).summary).toContain("发报价单");

    const t = await prisma.task.findFirstOrThrow({ where: { customerId: cid } });
    await toggleTask(t.id, true);
    expect((await 最新日志()).summary).toContain("已完成");

    await deleteTask(t.id);
    const log = await 最新日志();
    expect(log.action).toBe("delete");
    expect(log.entity).toBe("Task");
  });

  it("排计划、完成计划都留痕", async () => {
    const cid = await 建一个("计划的客户", "13800000104");
    await savePlan({ customerId: cid, subject: "谈合同", plannedAt: new Date(2026, 8, 20, 9, 0, 0).toISOString(), method: "电话沟通" });
    expect((await 最新日志()).summary).toContain("谈合同");

    const pl = await prisma.followPlan.findFirstOrThrow({ where: { customerId: cid } });
    await completePlan(pl.id);
    expect((await 最新日志()).summary).toContain("完成跟进计划");
  });

  it("联系人的增删都留痕", async () => {
    const cid = await 建一个("联系人的客户", "13800000105");
    await saveContact({ customerId: cid, name: "王经理", position: "采购", phone: "13900000001", email: null, wechat: null, isPrimary: true, remark: null });
    expect((await 最新日志()).summary).toContain("王经理");

    const c = await prisma.contact.findFirstOrThrow({ where: { customerId: cid } });
    await deleteContact(c.id);
    const log = await 最新日志();
    expect(log.action).toBe("delete");
    expect(log.entity).toBe("Contact");
    expect(log.summary).toContain("王经理");
  });

  it("新建线索也留痕（原来只有删除记）", async () => {
    await saveLead({ name: "某某公司", source: "官网注册", status: "待跟进" });
    const log = await 最新日志();
    expect(log.action).toBe("create");
    expect(log.entity).toBe("Lead");
    expect(log.summary).toContain("某某公司");
  });
});

describe("记录本身要结实", () => {
  it("成员被删掉，他的历史操作记录仍然在", async () => {
    await 建一个("张三");
    const 之前 = await prisma.auditLog.count();
    expect(之前).toBeGreaterThan(0);

    // 先把学员清掉，否则 salesOwner 外键挡着删不了人
    await prisma.customer.deleteMany();
    await prisma.user.delete({ where: { id: jia.id } });

    const log = await 最新日志();
    expect(log.userName).toBe("甲"); // 姓名是冗余存的，不随人消失
    expect(await prisma.auditLog.count()).toBeGreaterThanOrEqual(之前);
  });

  it("写日志失败不能把业务操作带下水", async () => {
    const 原create = prisma.auditLog.create;
    // @ts-expect-error 故意塞一个会抛错的实现
    prisma.auditLog.create = async () => { throw new Error("模拟日志表写坏了"); };
    try {
      const id = await 建一个("日志坏了也要能建档", "13800000008");
      expect(id).toBeTruthy();
      expect(await prisma.customer.count({ where: { id } })).toBe(1);
    } finally {
      prisma.auditLog.create = 原create;
    }
  });

  it("不记录任何密码内容", async () => {
    await recordAudit({
      user: { id: jia.id, name: "甲" },
      action: "password", entity: "User", entityId: jia.id,
      summary: "甲 修改了自己的登录密码",
    });
    const log = await 最新日志();
    expect(log.summary).not.toMatch(/[Cc]rm@|password|密码是/);
    expect(log.detail).toBeNull();
  });
});

describe("日期留痕不能差一天", () => {
  it("按本地时区记，不是 UTC", async () => {
    const { describeCustomerChanges } = await import("@/lib/audit");
    // 本地 2026-10-15 00:00（东八区）= UTC 2026-10-14T16:00。
    // 取 ISO 前十位会记成 10-14，而库里和页面上都是 10-15
    const 本地零点 = new Date("2026-10-14T16:00:00.000Z");
    const r = describeCustomerChanges(["expectedSignAt"], { expectedSignAt: null }, { expectedSignAt: 本地零点 });
    expect(r[0].新值).toBe("2026-10-15");
  });
});
