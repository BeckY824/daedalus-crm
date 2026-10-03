/**
 * 同一个数各页对不上（2026-10-01 逐页排查的 C 档）。
 * 用户在 A 页看到 5，点进去列表是 4，就会觉得系统出错了。这里钉住各处的口径。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { saveOpportunity, moveStage, setOppStatus } from "@/app/(app)/opportunities/actions";

let 客户: { id: string };

beforeEach(async () => {
  await resetDb();
  const u = await prisma.user.create({ data: { email: "a@x", name: "甲", title: "管理员", role: "ADMIN", password: "x" } });
  mocks.user.id = u.id;
  客户 = await prisma.customer.create({ data: { name: "张三", phone: "13800000001", salesOwnerId: u.id } });
});

afterAll(async () => { await prisma.$disconnect(); });

const 商机 = (extra: Partial<Parameters<typeof saveOpportunity>[0]> = {}) => ({
  name: "暑期班", customerId: 客户.id, amount: 5000, stage: "初步沟通", status: "OPEN", probability: 10, ownerId: mocks.user.id, ...extra,
});
const 读 = (id: string) => prisma.opportunity.findUniqueOrThrow({ where: { id }, include: { closed: true } });

describe("C6 商机的阶段和状态绑在一起；赢单时刻单独记", () => {
  it("阶段选了「赢单成交」就是赢单；状态标了赢单，阶段就推到「赢单成交」", async () => {
    await saveOpportunity(商机({ stage: "赢单成交", status: "OPEN" }));
    await saveOpportunity(商机({ name: "第二单", stage: "方案报价", status: "WON" }));
    const 全部 = await prisma.opportunity.findMany({ orderBy: { name: "asc" } });
    expect(全部.map((o) => [o.stage, o.status])).toEqual([["赢单成交", "WON"], ["赢单成交", "WON"]]);
  });

  it("丢单不限阶段：丢在哪一步本身有用", async () => {
    await saveOpportunity(商机({ stage: "方案报价", status: "LOST" }));
    expect(await prisma.opportunity.findFirstOrThrow()).toMatchObject({ stage: "方案报价", status: "LOST" });
  });

  it("赢单时记下那一刻；之后改备注不挪它；重新打开就删掉", async () => {
    await saveOpportunity(商机());
    const o = await prisma.opportunity.findFirstOrThrow();
    expect((await 读(o.id)).closed).toBeNull();

    await setOppStatus(o.id, "WON");
    const 赢时 = (await 读(o.id)).closed!.closedAt;
    expect(赢时).toBeInstanceOf(Date);

    // 往回拨一个月，装作是上个月赢的：改备注之后它还得是上个月的
    const 上月 = new Date(Date.now() - 30 * 86400_000);
    await prisma.opportunityClose.update({ where: { opportunityId: o.id }, data: { closedAt: 上月 } });
    const 现在 = await 读(o.id);
    await saveOpportunity({ ...商机({ stage: 现在.stage, status: 现在.status, probability: 现在.probability }), id: o.id, remark: "补个备注" });
    expect((await 读(o.id)).closed!.closedAt.getTime()).toBe(上月.getTime());

    await setOppStatus(o.id, "OPEN", { stage: "方案报价", probability: 60 });
    expect((await 读(o.id)).closed).toBeNull();
  });

  it("拖进「赢单成交」也记；丢单也记", async () => {
    await saveOpportunity(商机());
    await saveOpportunity(商机({ name: "要丢的" }));
    const [a, b] = await prisma.opportunity.findMany({ orderBy: { name: "asc" } });
    await moveStage(a.id, "赢单成交");
    await setOppStatus(b.id, "LOST");
    expect((await 读(a.id)).closed).not.toBeNull();
    expect((await 读(b.id)).closed).not.toBeNull();
  });
});

describe("C4 AI 报的数和页面一个口径", () => {
  // 工具要的上下文：只用到 userId 和叫法
  const 跑 = async (名: string, args: Record<string, unknown> = {}) => {
    const { TOOL_MAP } = await import("@/lib/agent/tools");
    const { DEFAULT_BUSINESS } = await import("@/lib/business-config");
    return TOOL_MAP.get(名)!.run(args, {
      userId: mocks.user.id, userName: "甲", b: DEFAULT_BUSINESS, recordOffset: 0, proposals: [],
    } as never) as Promise<{ summary: string; data: Record<string, unknown> }>;
  };

  it("我的计划：今天上午没做的还算今天的，不算逾期（和首页、角标一样按今天零点）；条数数全量", async () => {
    const 今早 = new Date(); 今早.setHours(0, 30, 0, 0);
    const 昨天 = new Date(Date.now() - 86400_000);
    await prisma.followPlan.create({ data: { customerId: 客户.id, ownerId: mocks.user.id, subject: "今早的", plannedAt: 今早 } });
    await prisma.followPlan.create({ data: { customerId: 客户.id, ownerId: mocks.user.id, subject: "昨天的", plannedAt: 昨天 } });
    for (let i = 0; i < 12; i++) await prisma.task.create({ data: { customerId: 客户.id, ownerId: mocks.user.id, title: `待办${i}` } });
    const r = await 跑("get_my_plans");
    expect(r.summary).toBe("2 条计划、12 条待办，其中 1 条已逾期");
  });

  it("渠道：「直接带来」只数没有上游学员的，和渠道页一样", async () => {
    const 小红 = await prisma.channel.create({ data: { name: "小红", channelOwnerId: mocks.user.id } });
    const 小明 = await prisma.customer.create({ data: { name: "小明", phone: "13800000011", salesOwnerId: mocks.user.id, channelId: 小红.id } });
    await prisma.customer.create({ data: { name: "室友", phone: "13800000012", salesOwnerId: mocks.user.id, channelId: 小红.id, referrerCustomerId: 小明.id } });
    const r = await 跑("list_channels");
    expect((r.data as unknown as Record<string, unknown>[])[0]).toMatchObject({ 名称: "小红", 直接带来: 1, 连转介绍一共: 2 });
  });

  it("商机合计按全量算，不是前 30 个", async () => {
    for (let i = 0; i < 32; i++) await saveOpportunity(商机({ name: `单${i}`, amount: 100 }));
    const r = await 跑("list_opportunities");
    expect(r.summary).toContain("32 个商机，合计 ¥ 3,200");
  });

  it("我的回顾：笔数数全量，不是前 50 笔", async () => {
    for (let i = 0; i < 55; i++) {
      await prisma.followUp.create({ data: { customerId: 客户.id, ownerId: mocks.user.id, type: "CALL", title: `第${i}次`, content: "聊了", status: "已完成", occurredAt: new Date() } });
    }
    const r = await 跑("my_recap");
    expect(r.summary).toContain("跟了 1 位");
    expect(r.summary).toContain("55 笔记录");
  });

  it("联系人：不加条件数的时候，说一声还有未归属的", async () => {
    await prisma.contact.create({ data: { customerId: 客户.id, name: "张妈妈" } });
    await prisma.unassignedContact.create({ data: { id: "u1", name: "李阿姨" } });
    const r = await 跑("query_records", { 表: "联系人", 只计数: true });
    expect(r.summary).toContain("1 条");
    expect(r.summary).toContain("另有 1 位未归属联系人");
  });

  it("线索转化过、客户后来被删了：还算已转化，和报表的转化率一个判法", async () => {
    await prisma.lead.create({ data: { name: "老线索", ownerId: mocks.user.id, status: "已转化", customerId: null } });
    const r = await 跑("list_leads");
    expect(JSON.stringify(r.data)).toContain('"已转化":true');
  });

  it("按跟进状态分组：用设置里改过的显示名", async () => {
    const { DEFAULT_BUSINESS } = await import("@/lib/business-config");
    const { TOOL_MAP } = await import("@/lib/agent/tools");
    const b = { ...DEFAULT_BUSINESS, statusLabels: { ...DEFAULT_BUSINESS.statusLabels, 待跟进: "还没聊" } };
    const r = (await TOOL_MAP.get("query_records")!.run({ 表: "客户", 分组: "跟进状态" }, {
      userId: mocks.user.id, userName: "甲", b, recordOffset: 0, proposals: [],
    } as never)) as { data: { 分组: Record<string, unknown>[] } };
    expect(r.data.分组[0]).toMatchObject({ 条数: 1 });
    expect(Object.values(r.data.分组[0])).toContain("还没聊");
  });
});

