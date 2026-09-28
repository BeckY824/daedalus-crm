/**
 * 建议卡落库：确认之后到底走了哪条路。
 *
 * 这是全套里最要紧的一条边界。AI 改字段时**不能自己写库**，必须把改动合并进
 * 整份记录再交给 saveCustomer——手机号查重、推荐链成环检查、归属字段重算、
 * 逐字段留痕都在那里面。绕过去的那一刻，AI 改出来的数据就和人改出来的不是一回事了，
 * 而且不会有任何报错告诉你这件事。
 *
 * 所以下面测的不是"字段有没有被改成新值"（那太容易过），
 * 而是"那些**本该跟着一起变的东西**变了没有、那些**本该拦住的**拦住了没有"。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));

import { applyProposal, undoProposal } from "@/app/(app)/dashboard/apply";

let 销售A: string;
let 销售B: string;
let 渠道: string;
let 客户: string;
let 推荐人: string;

beforeEach(async () => {
  await resetDb();
  const a = await prisma.user.create({ data: { email: "sa@t", name: "江城", role: "SALES", password: "x" } });
  const b = await prisma.user.create({ data: { email: "sb@t", name: "李蔚然", role: "SALES", password: "x" } });
  销售A = a.id;
  销售B = b.id;
  const ch = await prisma.channel.create({ data: { name: "林老师", channelOwnerId: b.id } });
  渠道 = ch.id;
  const r = await prisma.customer.create({ data: { name: "赵同学", phone: "13800001111", salesOwnerId: a.id, channelId: ch.id, attributionChannelId: ch.id, channelOwnerId: b.id } });
  推荐人 = r.id;
  const c = await prisma.customer.create({ data: { name: "陈同学", phone: "13800002222", salesOwnerId: a.id } });
  客户 = c.id;
});

const 卡 = (changes: Record<string, string>) => ({
  id: "p1",
  kind: "update_customer" as const,
  customerId: 客户,
  customerName: "陈同学",
  reason: "测试",
  changes: Object.entries(changes).map(([field, value]) => ({ field: field as never, value })),
});

describe("改档案会连带该变的都变", () => {
  it("改推荐人时归属字段跟着重算——只写推荐人本身就等于漏了业绩归属", async () => {
    const 前 = await prisma.customer.findUnique({ where: { id: 客户 } });
    expect(前!.attributionChannelId).toBeNull();
    expect(前!.channelOwnerId).toBeNull();

    const r = await applyProposal(卡({ referrerName: "赵同学" }));
    expect(r.ok).toBe(true);

    const 后 = await prisma.customer.findUnique({ where: { id: 客户 } });
    expect(后!.referrerCustomerId).toBe(推荐人);
    // 赵同学是渠道直推，不足两代，所以归属取链条顶端那个渠道
    expect(后!.attributionChannelId).toBe(渠道);
    // 渠道负责人整条链继承，这个字段漏了的话业绩排行就算不对
    expect(后!.channelOwnerId).toBe(销售B);
  });

  it("落库要留痕，而且记清楚改了哪一项", async () => {
    await applyProposal(卡({ followStatus: "已签约" }));
    const 日志 = await prisma.auditLog.findMany({ where: { entityId: 客户 } });
    expect(日志.length).toBeGreaterThan(0);
    expect(日志.some((l) => l.summary.includes("跟进状态"))).toBe(true);
  });

  it("一次改多项，每一项都落下去", async () => {
    /* grade 那一格是枚举，选项来自业务配置——默认这套是「职位」，
       写「研一」会被当场拒掉（教培预设下才认它）。这正是通用版要的行为。 */
    const r = await applyProposal(卡({ school: "远望信息", grade: "技术", remark: "对方同意" }));
    expect(r.ok).toBe(true);
    const 后 = await prisma.customer.findUnique({ where: { id: 客户 } });
    expect([后!.school, 后!.grade, 后!.remark]).toEqual(["远望信息", "技术", "对方同意"]);
  });

  it("没动的字段一个都不许变", async () => {
    const 前 = await prisma.customer.findUnique({ where: { id: 客户 } });
    await applyProposal(卡({ remark: "只改这一条" }));
    const 后 = await prisma.customer.findUnique({ where: { id: 客户 } });
    expect(后!.name).toBe(前!.name);
    expect(后!.phone).toBe(前!.phone);
    expect(后!.salesOwnerId).toBe(前!.salesOwnerId);
    expect(后!.followStatus).toBe(前!.followStatus);
  });
});

describe("该拦的必须拦住——这些校验都在 saveCustomer 里，绕过去就全没了", () => {
  it("手机号改成别人的要拒", async () => {
    const r = await applyProposal(卡({ phone: "13800001111" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("已存在");
    // 拒了就得原样没动
    expect((await prisma.customer.findUnique({ where: { id: 客户 } }))!.phone).toBe("13800002222");
  });

  it("推荐链成环要拒", async () => {
    // 先让赵同学的推荐人是陈同学，再想把陈同学的推荐人设成赵同学 → 成环
    await prisma.customer.update({ where: { id: 推荐人 }, data: { referrerCustomerId: 客户 } });
    const r = await applyProposal(卡({ referrerName: "赵同学" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("成环");
  });

  it("重名的负责人不许猜——猜错就是把客户挂到别人名下", async () => {
    await prisma.user.create({ data: { email: "sc@t", name: "江城", role: "SALES", password: "x" } });
    const r = await applyProposal(卡({ salesOwnerName: "江城" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("同事都叫");
    expect((await prisma.customer.findUnique({ where: { id: 客户 } }))!.salesOwnerId).toBe(销售A);
  });

  it("不存在的负责人要报清楚，不是静默留空", async () => {
    const r = await applyProposal(卡({ salesOwnerName: "查无此人" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("查无此人");
  });

  it("卡片上被人改成非法枚举，服务端要再收一遍——前端禁用按钮不算防线", async () => {
    const r = await applyProposal(卡({ followStatus: "我自己编的状态" }));
    expect(r.ok).toBe(false);
  });

  it("客户已被删除时报得明白", async () => {
    const c = 卡({ remark: "x" });
    await prisma.customer.delete({ where: { id: 客户 } });
    const r = await applyProposal(c);
    expect(r.ok).toBe(false);
  });
});

describe("商机与签约也走原有 action", () => {
  it("新建商机：负责人跟着客户的销售负责人走", async () => {
    const r = await applyProposal({
      id: "p2", kind: "add_opportunity", customerId: 客户, customerName: "陈同学", reason: "测试",
      name: "秋季班", amount: 19800, stage: "谈判审核", probability: 70, expectedDealAt: "", remark: "",
    });
    expect(r.ok).toBe(true);
    const o = await prisma.opportunity.findFirst({ where: { customerId: 客户 } });
    expect(o!.amount).toBe(19800);
    expect(o!.ownerId).toBe(销售A);
    expect(o!.status).toBe("OPEN");
  });

  it("商机金额为负要被原有校验拦住", async () => {
    const r = await applyProposal({
      id: "p3", kind: "add_opportunity", customerId: 客户, customerName: "陈同学", reason: "测试",
      name: "秋季班", amount: -5, stage: "初步沟通", probability: 10, expectedDealAt: "", remark: "",
    });
    expect(r.ok).toBe(false);
    expect(await prisma.opportunity.count()).toBe(0);
  });

  it("记一笔签约", async () => {
    const r = await applyProposal({
      id: "p4", kind: "add_contract", customerId: 客户, customerName: "陈同学", reason: "测试",
      amount: 19800, signedAt: new Date("2026-09-01").toISOString(), remark: "首付",
    });
    expect(r.ok).toBe(true);
    const k = await prisma.contract.findFirst({ where: { customerId: 客户 } });
    expect(k!.amount).toBe(19800);
  });
});

/**
 * 撤销：确认之后发现不对，点一下回到确认之前。
 * 只开了两种能干净还原的（记跟进、改状态）；凭据从前端带回来，和卡片一样不可信。
 */
describe("撤销刚确认的建议卡", () => {
  // 记跟进要落 ownerId，登录的那位得真在库里
  beforeEach(async () => {
    await prisma.user.create({ data: { id: "tester-id", email: "tester@t", name: "测试员", role: "ADMIN", password: "x" } });
  });

  const 跟进卡 = () => ({
    id: "u1", kind: "add_followup" as const, customerId: 客户, customerName: "陈同学", reason: "测试",
    type: "PHONE", title: "", content: "电话聊了报价", occurredAt: new Date("2026-09-20T10:00:00").toISOString(),
  });

  it("记跟进：撤销后那条跟进没了，「最近跟进」退回原来的时间", async () => {
    const 旧 = new Date("2026-09-01T09:00:00");
    await prisma.followUp.create({ data: { customerId: 客户, type: "PHONE", title: "", content: "早先那次", status: "已完成", occurredAt: 旧, ownerId: 销售A } });
    await prisma.customer.update({ where: { id: 客户 }, data: { lastFollowAt: 旧 } });

    const r = await applyProposal(跟进卡());
    expect(r.ok && r.撤销?.kind).toBe("add_followup");
    expect((await prisma.customer.findUnique({ where: { id: 客户 } }))!.lastFollowAt!.getTime()).toBeGreaterThan(旧.getTime());

    const u = await undoProposal(r.ok ? r.撤销! : (null as never));
    expect(u.ok).toBe(true);
    expect(await prisma.followUp.count({ where: { customerId: 客户 } })).toBe(1);
    expect((await prisma.customer.findUnique({ where: { id: 客户 } }))!.lastFollowAt!.getTime()).toBe(旧.getTime());
    expect(await prisma.auditLog.count({ where: { action: "ai_undo" } })).toBe(1);
  });

  it("改状态：撤销后回到原值", async () => {
    await prisma.customer.update({ where: { id: 客户 }, data: { followStatus: "跟进中" } });
    const r = await applyProposal({ id: "u2", kind: "set_status", customerId: 客户, customerName: "陈同学", reason: "测试", field: "followStatus", to: "意向较高" });
    expect(r.ok).toBe(true);
    expect((await prisma.customer.findUnique({ where: { id: 客户 } }))!.followStatus).toBe("意向较高");
    expect(await undoProposal(r.ok ? r.撤销! : (null as never))).toEqual({ ok: true });
    expect((await prisma.customer.findUnique({ where: { id: 客户 } }))!.followStatus).toBe("跟进中");
  });

  it("凭据被改成别的客户的跟进：一条都不删", async () => {
    const 别人的 = await prisma.followUp.create({ data: { customerId: 推荐人, type: "PHONE", title: "", content: "赵同学的", status: "已完成", occurredAt: new Date(), ownerId: 销售A } });
    const u = await undoProposal({ kind: "add_followup", customerId: 客户, id: 别人的.id });
    expect(u.ok).toBe(false);
    expect(await prisma.followUp.findUnique({ where: { id: 别人的.id } })).not.toBeNull();
  });

  it("不支持的种类不动任何东西", async () => {
    const u = await undoProposal({ kind: "add_contract", customerId: 客户 } as never);
    expect(u.ok).toBe(false);
  });

  it("签约、商机这些不给撤销凭据——撤回会牵连别处，没想清楚之前不开", async () => {
    const r = await applyProposal({
      id: "u3", kind: "add_contract", customerId: 客户, customerName: "陈同学", reason: "测试",
      amount: 5000, signedAt: new Date("2026-09-01").toISOString(), remark: "",
    });
    expect(r.ok && r.撤销).toBeUndefined();
  });
});
