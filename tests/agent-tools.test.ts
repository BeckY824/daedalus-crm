/**
 * agent 手上的「清单类」只读工具。
 *
 * 2026-09-18 报上来的那条：问「我目前的渠道有哪些」，它调了
 * `query_metric(customers_count, groupBy=channel)`，拿回一行，然后想了 74 秒。
 * 根因不是模型笨，是**它够不着数据**——那时工具只有客户那条线加一个指标聚合，
 * 而按渠道分组的客户数里，**没带来过客户的渠道根本不出现**，答案必然是错的。
 *
 * 所以这组用例盯的是「够得着」：新建一个还没有任何客户的渠道，它也得出现在清单里。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { TOOLS } from "@/lib/agent/tools";
import { DEFAULT_BUSINESS } from "@/lib/business-config";

let 我: { id: string };

const ctx = () => ({ userId: 我.id, userName: "甲", b: DEFAULT_BUSINESS, recordOffset: 0, proposals: [] });
const 用 = (name: string) => {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`没有叫 ${name} 的工具`);
  return t;
};

beforeEach(async () => {
  await resetDb();
  我 = await prisma.user.create({ data: { email: "jia", name: "甲", title: "销售", role: "SALES", password: "x" } });
});

afterAll(async () => { await prisma.$disconnect(); });

describe("list_channels", () => {
  it("一个客户都没带来的渠道也要列出来——这正是原来答错的那一类", async () => {
    await prisma.channel.create({ data: { name: "小红书", channelOwnerId: 我.id } });
    const r = await 用("list_channels").run({}, ctx());
    const 名字 = (r.data as { 名称: string }[]).map((c) => c.名称);
    expect(名字).toEqual(["小红书"]);
    expect(r.summary).toContain("1 个渠道");
  });

  it("带出负责人、带来多少客户、这条链上的签约额", async () => {
    const ch = await prisma.channel.create({ data: { name: "老客户转介绍", channelOwnerId: 我.id } });
    const c = await prisma.customer.create({
      data: { name: "张三", phone: "13800000001", followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我.id, channelId: ch.id },
    });
    await prisma.contract.create({ data: { customerId: c.id, amount: 19800, signedAt: new Date() } });

    const [行] = (await 用("list_channels").run({}, ctx())).data as { 渠道负责人: string; 直接带来: number; 签约额: number }[];
    expect(行.渠道负责人).toBe("甲");
    expect(行.直接带来).toBe(1);
    expect(行.签约额).toBe(19800);
  });

  it("默认不列停用的，要看得显式要", async () => {
    await prisma.channel.create({ data: { name: "停了的", channelOwnerId: 我.id, active: false } });
    expect((await 用("list_channels").run({}, ctx())).data).toEqual([]);
    expect(((await 用("list_channels").run({ includeInactive: true }, ctx())).data as unknown[]).length).toBe(1);
  });
});

describe("list_leads", () => {
  beforeEach(async () => {
    await prisma.lead.createMany({
      data: [
        { name: "DDW-Display", contact: "Steven", phone: "13417558100", source: "其他", status: "待跟进", ownerId: 我.id },
        { name: "已经跟上的", source: "转介绍", status: "跟进中", ownerId: 我.id },
      ],
    });
  });

  it("线索是另一张表：列出来，带状态和来源", async () => {
    const r = await 用("list_leads").run({}, ctx());
    const d = r.data as { 总数: number; 线索: { 名称: string; 状态: string }[] };
    expect(d.总数).toBe(2);
    expect(d.线索.map((l) => l.名称).sort()).toEqual(["DDW-Display", "已经跟上的"]);
  });

  it("按状态筛", async () => {
    const d = (await 用("list_leads").run({ status: "跟进中" }, ctx())).data as { 总数: number };
    expect(d.总数).toBe(1);
  });

  it("按关键词能搜到联系人和电话", async () => {
    const d = (await 用("list_leads").run({ keyword: "Steven" }, ctx())).data as { 线索: { 名称: string }[] };
    expect(d.线索[0].名称).toBe("DDW-Display");
  });
});

describe("list_opportunities", () => {
  beforeEach(async () => {
    const c = await prisma.customer.create({
      data: { name: "张三", phone: "13800000002", followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我.id },
    });
    await prisma.opportunity.createMany({
      data: [
        { name: "大单", customerId: c.id, amount: 200000, stage: "方案报价", status: "OPEN", probability: 60, ownerId: 我.id },
        { name: "小单", customerId: c.id, amount: 5000, stage: "初步沟通", status: "OPEN", probability: 20, ownerId: 我.id },
        { name: "丢了的", customerId: c.id, amount: 90000, stage: "谈判审核", status: "LOST", probability: 0, ownerId: 我.id },
      ],
    });
  });

  it("默认只列进行中的，按金额从大到小", async () => {
    const r = await 用("list_opportunities").run({}, ctx());
    const d = r.data as { 总数: number; 商机: { 名称: string; 金额: number }[] };
    expect(d.商机.map((o) => o.名称)).toEqual(["大单", "小单"]);
    expect(r.summary).toContain("205000");
  });

  it("要丢单的得显式要——不然「手上有哪些单子」会把丢掉的也算进去", async () => {
    const d = (await 用("list_opportunities").run({ status: "LOST" }, ctx())).data as { 商机: { 名称: string; 状态: string }[] };
    expect(d.商机.map((o) => o.名称)).toEqual(["丢了的"]);
    expect(d.商机[0].状态).toBe("丢单");
  });
});

describe("search_followups", () => {
  beforeEach(async () => {
    const c = await prisma.customer.create({
      data: { name: "张三", phone: "13800000003", followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我.id },
    });
    await prisma.followUp.createMany({
      data: [
        { customerId: c.id, ownerId: 我.id, type: "PHONE", title: "", content: "问了预算，说年底才批", status: "已完成", occurredAt: new Date() },
        { customerId: c.id, ownerId: 我.id, type: "PHONE", title: "", content: "寄了样品", status: "已完成", occurredAt: new Date() },
      ],
    });
  });

  it("跨客户按词找，带出是谁、什么时候", async () => {
    const r = await 用("search_followups").run({ keyword: "预算" }, ctx());
    const d = r.data as { 总数: number; 记录: { 客户: string; 内容: string }[] };
    expect(d.总数).toBe(1);
    expect(d.记录[0].客户).toBe("张三");
    expect(d.记录[0].内容).toContain("年底才批");
  });

  it("没给关键词时明确报错，不是把全库倒出来", async () => {
    const r = await 用("search_followups").run({}, ctx());
    expect((r.data as { error?: string }).error).toBeTruthy();
  });
});
