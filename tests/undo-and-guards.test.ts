/**
 * 撤销、确认、并发那一档（2026-10-01 逐页排查的 D 档）：
 * 做了能撤回、撤回去是原样、别人刚改的不被盖掉、改了配置旧数据还存得了。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { saveOpportunity, moveStage, deleteOpportunities, restoreOpportunities, 删商机前清点 } from "@/app/(app)/opportunities/actions";
import { deleteFollowUp, restoreFollowUp, saveContact } from "@/app/(app)/customers/[id]/actions";
import { saveChannel } from "@/app/(app)/channels/actions";
import { saveLead } from "@/app/(app)/leads/actions";
import { applyProposal } from "@/app/(app)/dashboard/apply";
import { assignSalesOwner, bulkFollowStatus } from "@/app/(app)/customers/actions";

let 客户: { id: string };

beforeEach(async () => {
  await resetDb();
  const u = await prisma.user.create({ data: { email: "a@x", name: "甲", title: "管理员", role: "ADMIN", password: "x" } });
  mocks.user.id = u.id;
  客户 = await prisma.customer.create({ data: { name: "张三", phone: "13800000001", salesOwnerId: u.id } });
});

afterAll(async () => { await prisma.$disconnect(); });

describe("D5 改了业务配置，旧线索还存得了", () => {
  it("来源不在现在的列表里，但没改它：照样能改备注", async () => {
    const l = await prisma.lead.create({ data: { name: "老线索", ownerId: mocks.user.id, source: "早就删掉的来源" } });
    const r = await saveLead({ id: l.id, name: "老线索", source: "早就删掉的来源", status: "待跟进", remark: "补个备注" });
    expect(r).toMatchObject({ ok: true });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).remark).toBe("补个备注");
  });

  it("填一个不在列表里的来源：收下（2026-10-02 起来源能选也能填）；太长的拦", async () => {
    const l = await prisma.lead.create({ data: { name: "老线索", ownerId: mocks.user.id, source: "其他" } });
    expect(await saveLead({ id: l.id, name: "老线索", source: "视频号直播间", status: "待跟进" })).toMatchObject({ ok: true });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).source).toBe("视频号直播间");
    expect(await saveLead({ id: l.id, name: "老线索", source: "长".repeat(31), status: "待跟进" })).toMatchObject({ ok: false });
  });
});

describe("D6 拖进赢单成交再撤销，手填的概率回得来", () => {
  it("75% 拖进赢单成交变成 100，撤销回到方案报价：还是 75，不是方案报价的默认值", async () => {
    await saveOpportunity({ name: "单", customerId: 客户.id, amount: 1000, stage: "方案报价", status: "OPEN", probability: 75, ownerId: mocks.user.id });
    const o = await prisma.opportunity.findFirstOrThrow();
    await moveStage(o.id, "赢单成交");
    expect(await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ probability: 100, status: "WON" });
    await moveStage(o.id, "方案报价", 75);
    expect(await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ probability: 75, status: "OPEN", stage: "方案报价" });
  });
});

describe("D4 AI 建议卡出来之后同事改过同一格：不盖掉", () => {
  it("卡上写着「现在：待跟进」，期间同事改成了已签约：点确认不落库，说清楚", async () => {
    await prisma.customer.update({ where: { id: 客户.id }, data: { followStatus: "已签约" } });
    const r = await applyProposal({
      id: "p1", kind: "set_status", customerId: 客户.id, customerName: "张三", reason: "聊得不错",
      field: "followStatus", to: "意向较高", 现值: { followStatus: "待跟进" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("跟进状态");
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: 客户.id } })).followStatus).toBe("已签约");
  });

  it("没人动过：照常落库", async () => {
    const r = await applyProposal({
      id: "p2", kind: "update_customer", customerId: 客户.id, customerName: "张三", reason: "补备注",
      changes: [{ field: "remark", value: "想要周末班" }], 现值: { remark: "" },
    });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: 客户.id } })).remark).toBe("想要周末班");
  });
});

describe("D1 批量改负责人、批量改状态：回原值，撤销能改回去", () => {
  it("批量改状态：两位原来状态不同，撤销后各回各的", async () => {
    const 李四 = await prisma.customer.create({ data: { name: "李四", phone: "13800000002", salesOwnerId: mocks.user.id, followStatus: "意向较高" } });
    const r = await bulkFollowStatus([客户.id, 李四.id], "已流失");
    expect(r).toMatchObject({ ok: true, updated: 2 });
    if (!r.ok) throw new Error();
    expect(r.原值).toEqual(expect.arrayContaining([{ id: 客户.id, 值: "待跟进" }, { id: 李四.id, 值: "意向较高" }]));
    // 界面上的撤销：按原值分组再调一次
    for (const x of r.原值!) await bulkFollowStatus([x.id], x.值);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: 客户.id } })).followStatus).toBe("待跟进");
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: 李四.id } })).followStatus).toBe("意向较高");
  });

  it("批量改负责人：回原负责人；撤销后没做完的活也回去", async () => {
    const 乙 = await prisma.user.create({ data: { email: "b@x", name: "乙", title: "销售", role: "SALES", password: "x" } });
    const 待办 = await prisma.task.create({ data: { customerId: 客户.id, ownerId: mocks.user.id, title: "寄资料" } });
    const r = await assignSalesOwner([客户.id], 乙.id);
    if (!r.ok) throw new Error(r.error);
    expect(r.原值).toEqual([{ id: 客户.id, 值: mocks.user.id }]);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: 待办.id } })).ownerId).toBe(乙.id);
    await assignSalesOwner([客户.id], mocks.user.id);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: 客户.id } })).salesOwnerId).toBe(mocks.user.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: 待办.id } })).ownerId).toBe(mocks.user.id);
  });
});

describe("D2 删商机、删跟进都能撤销，撤回去是原样", () => {
  it("删商机：先说关联了几条跟进；撤销后同一个 id 回来，跟进重新挂上，赢单时刻也在", async () => {
    await saveOpportunity({ name: "暑期班", customerId: 客户.id, amount: 5000, stage: "赢单成交", status: "WON", probability: 100, ownerId: mocks.user.id });
    const o = await prisma.opportunity.findFirstOrThrow({ include: { closed: true } });
    const f = await prisma.followUp.create({ data: { customerId: 客户.id, ownerId: mocks.user.id, opportunityId: o.id, type: "PHONE", title: "谈价", content: "谈了", status: "已完成", occurredAt: new Date() } });
    expect(await 删商机前清点([o.id])).toEqual({ 跟进: 1, 赢单: 1 });

    const r = await deleteOpportunities([o.id]);
    expect((await prisma.followUp.findUniqueOrThrow({ where: { id: f.id } })).opportunityId).toBeNull();
    expect(await restoreOpportunities(r.快照)).toMatchObject({ 回来: 1, 没回来: 0 });
    const 回来 = await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id }, include: { closed: true } });
    expect(回来).toMatchObject({ name: "暑期班", status: "WON", amount: 5000 });
    expect(回来.closed?.closedAt.getTime()).toBe(o.closed!.closedAt.getTime());
    expect((await prisma.followUp.findUniqueOrThrow({ where: { id: f.id } })).opportunityId).toBe(o.id);
  });

  it("删跟进：AI 速记的原文一起回来", async () => {
    const f = await prisma.followUp.create({
      data: { customerId: 客户.id, ownerId: mocks.user.id, type: "PHONE", title: "首次电话", content: "聊了报价", status: "已完成", occurredAt: new Date(), source: { create: { text: "粘贴的聊天记录原文" } } },
    });
    const r = await deleteFollowUp(f.id, 客户.id);
    if (!r.ok) throw new Error(r.error);
    expect(await prisma.followUp.count()).toBe(0);
    expect(await restoreFollowUp(r.快照)).toMatchObject({ ok: true });
    const 回来 = await prisma.followUp.findUniqueOrThrow({ where: { id: f.id }, include: { source: true } });
    expect(回来).toMatchObject({ title: "首次电话", content: "聊了报价" });
    expect(回来.source?.text).toBe("粘贴的聊天记录原文");
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: 客户.id } })).lastFollowAt).not.toBeNull();
  });
});

describe("D3 编辑框开着时同事改过：保存不盖掉", () => {
  const 早一点 = (d: Date) => new Date(d.getTime() - 1000).toISOString();

  it("商机：同事在管道上拖了阶段，这边拿旧版本保存，被拦下，阶段还是同事拖的", async () => {
    await saveOpportunity({ name: "单", customerId: 客户.id, amount: 1000, stage: "方案报价", status: "OPEN", probability: 60, ownerId: mocks.user.id });
    const o = await prisma.opportunity.findFirstOrThrow();
    const 打开时 = o.updatedAt.toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await moveStage(o.id, "谈判审核"); // 同事拖的
    const r = await saveOpportunity({ id: o.id, 版本: 打开时, name: "单", customerId: 客户.id, amount: 2000, stage: "方案报价", status: "OPEN", probability: 60, ownerId: mocks.user.id });
    expect(r.ok).toBe(false);
    expect(await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ stage: "谈判审核", amount: 1000 });
  });

  it("商机：没人动过，照常保存", async () => {
    await saveOpportunity({ name: "单", customerId: 客户.id, amount: 1000, stage: "方案报价", status: "OPEN", probability: 60, ownerId: mocks.user.id });
    const o = await prisma.opportunity.findFirstOrThrow();
    const r = await saveOpportunity({ id: o.id, 版本: o.updatedAt.toISOString(), name: "单", customerId: 客户.id, amount: 2000, stage: "方案报价", status: "OPEN", probability: 60, ownerId: mocks.user.id });
    expect(r.ok).toBe(true);
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).amount).toBe(2000);
  });

  it("线索、渠道、联系人：版本对不上一样拦", async () => {
    const l = await prisma.lead.create({ data: { name: "线索", ownerId: mocks.user.id } });
    expect(await saveLead({ id: l.id, 版本: 早一点(l.updatedAt), name: "改了", source: "其他", status: "待跟进" })).toMatchObject({ ok: false });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).name).toBe("线索");

    const ch = await prisma.channel.create({ data: { name: "小红", channelOwnerId: mocks.user.id } });
    expect(await saveChannel({ id: ch.id, 版本: 早一点(ch.updatedAt), name: "小红改", phone: null, remark: null, channelOwnerId: mocks.user.id })).toMatchObject({ ok: false });
    expect((await prisma.channel.findUniqueOrThrow({ where: { id: ch.id } })).name).toBe("小红");

    const c = await prisma.contact.create({ data: { customerId: 客户.id, name: "张妈妈" } });
    expect(await saveContact({ id: c.id, 版本: 早一点(c.updatedAt), customerId: 客户.id, name: "改了", isPrimary: false })).toMatchObject({ ok: false });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).name).toBe("张妈妈");
  });
});

