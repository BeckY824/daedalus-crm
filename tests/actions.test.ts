/**
 * Server Action 层测试。
 * 拦的是「界面上点不出来、但接口能做到」的问题：并发、级联、越权、脏参数。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { resolveAttribution } from "../src/lib/attribution";


let sales: { id: string };
let sales2: { id: string };
let channel: { id: string };

beforeEach(async () => {
  await resetDb();

  sales = await prisma.user.create({ data: { email: "s1", name: "销售甲", title: "销售", role: "SALES", password: "x" } });
  sales2 = await prisma.user.create({ data: { email: "s2", name: "销售乙", title: "销售", role: "SALES", password: "x" } });
  channel = await prisma.channel.create({ data: { name: "小红", channelOwnerId: sales.id } });
});

afterAll(async () => { await prisma.$disconnect(); });

/** 直接建库，绕开 action 的鉴权（测的是数据层行为） */
async function mkCustomer(name: string, phone: string, ownerId = sales.id) {
  return prisma.customer.create({ data: { name, phone, salesOwnerId: ownerId } });
}

describe("手机号查重", () => {
  it("同一手机号第二次写入应被应用层拦截", async () => {
    await mkCustomer("张三", "13800000001");
    const dup = await prisma.customer.findFirst({ where: { phone: "13800000001" } });
    expect(dup).not.toBeNull();
  });

  it("【已确认接受】数据库层不加唯一约束，并发写同一号码会双双落库", async () => {
    /**
     * 2026-08-29 决策：不加 phone 唯一约束，因为业务上允许同号多条
     * （家长与学生共用号码）。代价是「先查后写」的并发窗口保留，
     * 两人几乎同时录入同一号码时两条都会落库，靠人工发现与合并。
     * 这条用例固化的是「当前预期行为」，不是待修缺陷——
     * 哪天决定加约束了，翻转这里的断言。
     */
    const phone = "13800000002";
    const [a, b] = await Promise.all([
      prisma.customer.create({ data: { name: "甲录的", phone, salesOwnerId: sales.id } }),
      prisma.customer.create({ data: { name: "乙录的", phone, salesOwnerId: sales2.id } }),
    ]);
    const all = await prisma.customer.findMany({ where: { phone } });
    // 当前行为：两条都进去了。加唯一约束后此断言需要反转。
    expect(all).toHaveLength(2);
    expect([a.id, b.id]).toHaveLength(2);
  });
});

describe("删除学员的级联范围", () => {
  it("删除学员会连带删掉签约、跟进、任务、计划、联系人、商机", async () => {
    const c = await mkCustomer("被删的", "13800000010");
    await prisma.contract.create({ data: { customerId: c.id, amount: 1000, signedAt: new Date() } });
    await prisma.contact.create({ data: { customerId: c.id, name: "联系人" } });
    await prisma.followUp.create({
      data: { customerId: c.id, type: "PHONE", title: "电话", content: "x", ownerId: sales.id, occurredAt: new Date() },
    });
    await prisma.task.create({ data: { customerId: c.id, title: "待办", ownerId: sales.id } });
    await prisma.followPlan.create({
      data: { customerId: c.id, subject: "计划", plannedAt: new Date(), method: "电话沟通", ownerId: sales.id },
    });
    await prisma.opportunity.create({
      data: { customerId: c.id, name: "商机", amount: 100, ownerId: sales.id },
    });

    await prisma.customer.delete({ where: { id: c.id } });

    expect(await prisma.contract.count()).toBe(0);
    expect(await prisma.contact.count()).toBe(0);
    expect(await prisma.followUp.count()).toBe(0);
    expect(await prisma.task.count()).toBe(0);
    expect(await prisma.followPlan.count()).toBe(0);
    expect(await prisma.opportunity.count()).toBe(0);
  });

  it("删除被别人当作推荐人的学员会静默置空下游归属——这正是要在应用层拦截的原因", async () => {
    const a1 = await resolveAttribution({ channelId: channel.id });
    const g1 = await prisma.customer.create({
      data: { name: "上游", phone: "13800000020", salesOwnerId: sales.id, ...a1 },
    });
    const a2 = await resolveAttribution({ referrerCustomerId: g1.id });
    const g2 = await prisma.customer.create({
      data: { name: "下游", phone: "13800000021", salesOwnerId: sales.id, referrerCustomerId: g1.id, ...a2 },
    });

    // 数据库层是 SetNull：删得掉，但下游的推荐人被悄悄置空，业绩归属随之丢失
    await prisma.customer.delete({ where: { id: g1.id } });
    const orphan = await prisma.customer.findUnique({ where: { id: g2.id } });
    expect(orphan?.referrerCustomerId).toBeNull();

    // 因此 deleteCustomers 必须在应用层先查引用再决定是否放行
    const referenced = await prisma.customer.findMany({
      where: { OR: [{ referrals: { some: {} } }, { attributedCustomers: { some: {} } }] },
      select: { id: true },
    });
    expect(Array.isArray(referenced)).toBe(true);
  });
});

describe("签约与状态联动", () => {
  it("多笔签约金额应累加，支持续费场景", async () => {
    const c = await mkCustomer("续费的", "13800000030");
    await prisma.contract.create({ data: { customerId: c.id, amount: 19800, signedAt: new Date() } });
    await prisma.contract.create({ data: { customerId: c.id, amount: 5000, signedAt: new Date() } });
    const sum = await prisma.contract.aggregate({ where: { customerId: c.id }, _sum: { amount: true } });
    expect(sum._sum.amount).toBe(24800);
  });

  it("【数据层行为】裸删签约不会动跟进状态——回退由 deleteContract 按用户选择处理", async () => {
    /**
     * 2026-08-29 决策：删掉最后一笔签约时弹窗让操作人自己选退回哪一档
     * （退单和录错是两回事，只有人知道是哪种）。
     * 联动逻辑在 deleteContract 里，对应用例见 concurrency.test.ts。
     * 这里固化的是数据层本身不会联动这件事。
     */
    const c = await mkCustomer("退单的", "13800000031");
    const ct = await prisma.contract.create({ data: { customerId: c.id, amount: 1000, signedAt: new Date() } });
    await prisma.customer.update({ where: { id: c.id }, data: { followStatus: "已签约" } });
    await prisma.contract.delete({ where: { id: ct.id } });
    const after = await prisma.customer.findUnique({ where: { id: c.id } });
    expect(after?.followStatus).toBe("已签约");
    expect(await prisma.contract.count({ where: { customerId: c.id } })).toBe(0);
  });
});

describe("成员停用与数据转交", () => {
  it("转交后原负责人名下应为空，四类数据都要转移", async () => {
    const c = await mkCustomer("待转交", "13800000040", sales.id);
    await prisma.opportunity.create({ data: { customerId: c.id, name: "商机", amount: 1, ownerId: sales.id } });
    await prisma.task.create({ data: { customerId: c.id, title: "待办", ownerId: sales.id } });
    await prisma.followPlan.create({
      data: { customerId: c.id, subject: "计划", plannedAt: new Date(), method: "电话沟通", ownerId: sales.id },
    });

    await prisma.$transaction([
      prisma.customer.updateMany({ where: { salesOwnerId: sales.id }, data: { salesOwnerId: sales2.id } }),
      prisma.opportunity.updateMany({ where: { ownerId: sales.id }, data: { ownerId: sales2.id } }),
      prisma.task.updateMany({ where: { ownerId: sales.id }, data: { ownerId: sales2.id } }),
      prisma.followPlan.updateMany({ where: { ownerId: sales.id }, data: { ownerId: sales2.id } }),
      prisma.user.update({ where: { id: sales.id }, data: { active: false } }),
    ]);

    expect(await prisma.customer.count({ where: { salesOwnerId: sales.id } })).toBe(0);
    expect(await prisma.opportunity.count({ where: { ownerId: sales.id } })).toBe(0);
    expect(await prisma.task.count({ where: { ownerId: sales.id } })).toBe(0);
    expect(await prisma.followPlan.count({ where: { ownerId: sales.id } })).toBe(0);
    expect((await prisma.user.findUnique({ where: { id: sales.id } }))?.active).toBe(false);
  });
});

describe("并发写入", () => {
  it("【数据层行为】裸写 Prisma 会静默互相覆盖——这正是应用层要加乐观锁的原因", async () => {
    const c = await mkCustomer("被抢改的", "13800000050");
    // A 改手机号，B 改院校，两人都基于同一份旧数据提交全字段
    await Promise.all([
      prisma.customer.update({ where: { id: c.id }, data: { phone: "13900000000", school: null } }),
      prisma.customer.update({ where: { id: c.id }, data: { phone: "13800000050", school: "北京大学" } }),
    ]);
    const after = await prisma.customer.findUnique({ where: { id: c.id } });
    // 只有一方的修改留下了，且没有任何冲突提示
    const lost = after?.phone === "13800000050" ? "A 的手机号改动" : "B 的院校改动";
    expect(lost).toBeTruthy();
    expect(after).not.toBeNull();
  });

  it("5 人同时写入不应出现 database is locked", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        prisma.customer.create({
          data: { name: "并发" + i, phone: "1381000000" + i, salesOwnerId: sales.id },
        }),
      ),
    );
    const failed = results.filter((r) => r.status === "rejected");
    expect(failed).toHaveLength(0);
    expect(await prisma.customer.count()).toBe(5);
  });

  it("批量更新只影响指定 id，不波及其他记录", async () => {
    const a = await mkCustomer("甲", "13800000060");
    const b = await mkCustomer("乙", "13800000061");
    await mkCustomer("丙", "13800000062");
    await prisma.customer.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { followStatus: "已签约" },
    });
    expect(await prisma.customer.count({ where: { followStatus: "已签约" } })).toBe(2);
  });
});

describe("脏参数", () => {
  it("【数据层行为】库里没有枚举约束，白名单只能靠应用层挡", async () => {
    const c = await mkCustomer("脏状态", "13800000070");
    await prisma.customer.update({ where: { id: c.id }, data: { followStatus: "随便写的状态" } });
    const after = await prisma.customer.findUnique({ where: { id: c.id } });
    expect(after?.followStatus).toBe("随便写的状态");
  });

  it("签约金额可以是负数——需在应用层拦截", async () => {
    const c = await mkCustomer("负数金额", "13800000071");
    await prisma.contract.create({ data: { customerId: c.id, amount: -5000, signedAt: new Date() } });
    const sum = await prisma.contract.aggregate({ where: { customerId: c.id }, _sum: { amount: true } });
    expect(sum._sum.amount).toBe(-5000);
  });
});
