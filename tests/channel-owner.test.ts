/**
 * 渠道负责人：谁的数据没动，谁的归属就不变。
 *
 * 之前改渠道负责人会 updateMany 把该渠道名下所有学员一起换掉——
 * 张沁做了一年的渠道换李蔚然接手，改一下负责人，张沁过去一年的业绩就全划走了，
 * 而且是静默的。这和 attribution.test.ts「归属固化」是同一条原则的两面，
 * 那边钉住了"改上游推荐人不追溯改写下游"，这里钉住"改渠道负责人不追溯改写已有学员"。
 *
 * 顺带钉住一个后门：去掉级联之后，saveCustomer 每次保存都重算归属的话，
 * 改一下备注就会从换过人的渠道重新算一遍，学员照样静默换主。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));

import { saveChannel } from "@/app/(app)/channels/actions";
import { saveCustomer, patchCustomer } from "@/app/(app)/customers/actions";
import { applyProposal } from "@/app/(app)/dashboard/apply";

let 张沁: string;
let 李蔚然: string;
let 陈牧: string;
let 渠道: string;
let 老学员: string;

beforeEach(async () => {
  await resetDb();
  张沁 = (await prisma.user.create({ data: { email: "a@t", name: "张沁", role: "SALES", password: "x" } })).id;
  李蔚然 = (await prisma.user.create({ data: { email: "b@t", name: "李蔚然", role: "SALES", password: "x" } })).id;
  陈牧 = (await prisma.user.create({ data: { email: "c@t", name: "陈牧", role: "SALES", password: "x" } })).id;
  渠道 = (await prisma.channel.create({ data: { name: "林老师", channelOwnerId: 张沁 } })).id;
  老学员 = (
    await prisma.customer.create({
      data: { name: "老学员", phone: "13800000001", salesOwnerId: 陈牧, channelId: 渠道, attributionChannelId: 渠道, channelOwnerId: 张沁 },
    })
  ).id;
});

/** 用整表保存改一个字段，其余照旧——模拟人在编辑框里只动了一项 */
async function 整表保存(id: string, 改: Record<string, unknown>) {
  const c = await prisma.customer.findUniqueOrThrow({ where: { id } });
  return saveCustomer({
    id,
    updatedAt: c.updatedAt.toISOString(),
    base: {
      name: c.name, phone: c.phone, school: c.school, grade: c.grade, major: c.major,
      followStatus: c.followStatus, decisionStatus: c.decisionStatus, expectedSignAt: c.expectedSignAt,
      remark: c.remark, salesOwnerId: c.salesOwnerId, channelId: c.channelId, referrerCustomerId: c.referrerCustomerId,
      channelOwnerId: c.channelOwnerId,
    },
    name: c.name, phone: c.phone, school: c.school, grade: c.grade, major: c.major,
    followStatus: c.followStatus, decisionStatus: c.decisionStatus, expectedSignAt: c.expectedSignAt,
    remark: c.remark, salesOwnerId: c.salesOwnerId, channelId: c.channelId, referrerCustomerId: c.referrerCustomerId,
    ...改,
  } as Parameters<typeof saveCustomer>[0]);
}

const 读 = (id: string) => prisma.customer.findUniqueOrThrow({ where: { id }, select: { channelOwnerId: true, attributionChannelId: true } });

describe("改渠道负责人不影响已有学员", () => {
  it("换人接手后，老学员还归原负责人，只有之后新增的归新人", async () => {
    const r = await saveChannel({ id: 渠道, name: "林老师", phone: null, remark: null, channelOwnerId: 李蔚然 });
    expect(r.ok).toBe(true);

    // 老学员一根头发没动
    expect((await 读(老学员)).channelOwnerId).toBe(张沁);

    // 之后新增的走新负责人
    const 新 = await saveCustomer({
      name: "新学员", phone: "13800000002", school: null, grade: null, major: null,
      followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null, remark: null,
      salesOwnerId: 陈牧, channelId: 渠道, referrerCustomerId: null,
    });
    expect(新.ok).toBe(true);
    if (新.ok) expect((await 读(新.id)).channelOwnerId).toBe(李蔚然);
  });

  it("留痕要写清「已有 N 名保持原归属」，而不是「连带改了 N 名」", async () => {
    await saveChannel({ id: 渠道, name: "林老师", phone: null, remark: null, channelOwnerId: 李蔚然 });
    const 日志 = await prisma.auditLog.findFirst({ where: { entity: "Channel", entityId: 渠道 }, orderBy: { id: "desc" } });
    expect(日志!.summary).toContain("保持原归属");
    expect(日志!.summary).not.toContain("连带改了");
  });
});

describe("后门：改别的字段不能把归属重算回去", () => {
  it("渠道换人之后，只改老学员的备注，他仍归原负责人", async () => {
    await saveChannel({ id: 渠道, name: "林老师", phone: null, remark: null, channelOwnerId: 李蔚然 });
    const r = await 整表保存(老学员, { remark: "只改备注" });
    expect(r.ok).toBe(true);
    expect((await 读(老学员)).channelOwnerId).toBe(张沁);
  });

  it("但改了推荐链（换了来源渠道）就该重算——改了输入才改输出", async () => {
    const 另一渠道 = (await prisma.channel.create({ data: { name: "方舟留学", channelOwnerId: 李蔚然 } })).id;
    const r = await 整表保存(老学员, { channelId: 另一渠道 });
    expect(r.ok).toBe(true);
    const c = await 读(老学员);
    expect(c.channelOwnerId).toBe(李蔚然);
    expect(c.attributionChannelId).toBe(另一渠道);
  });
});

describe("单独订正一位学员的渠道负责人", () => {
  it("整表保存时显式指定：只动这一位，同渠道的其他人不变", async () => {
    const 同学 = (
      await prisma.customer.create({ data: { name: "同渠道另一位", phone: "13800000003", salesOwnerId: 陈牧, channelId: 渠道, attributionChannelId: 渠道, channelOwnerId: 张沁 } })
    ).id;
    const r = await 整表保存(老学员, { channelOwnerId: 李蔚然 });
    expect(r.ok).toBe(true);
    expect((await 读(老学员)).channelOwnerId).toBe(李蔚然);
    expect((await 读(同学)).channelOwnerId).toBe(张沁);
  });

  it("记录页行内改：patchCustomer 一样只动这一位", async () => {
    expect((await patchCustomer(老学员, "channelOwnerId", 李蔚然)).ok).toBe(true);
    expect((await 读(老学员)).channelOwnerId).toBe(李蔚然);
  });

  it("清空 = 恢复按推荐链算，而不是变成没有负责人", async () => {
    await patchCustomer(老学员, "channelOwnerId", 李蔚然);
    expect((await patchCustomer(老学员, "channelOwnerId", null)).ok).toBe(true);
    // 推荐链顶端是林老师，负责人张沁
    expect((await 读(老学员)).channelOwnerId).toBe(张沁);
  });

  it("指定成停用的人要拒", async () => {
    await prisma.user.update({ where: { id: 李蔚然 }, data: { active: false } });
    const r = await patchCustomer(老学员, "channelOwnerId", 李蔚然);
    expect(r.ok).toBe(false);
    expect((await 读(老学员)).channelOwnerId).toBe(张沁);
  });

  it("留痕记的是「渠道负责人」这一项", async () => {
    await patchCustomer(老学员, "channelOwnerId", 李蔚然);
    const 日志 = await prisma.auditLog.findFirst({ where: { entityId: 老学员 }, orderBy: { id: "desc" } });
    expect(日志!.summary).toContain("渠道负责人");
  });
});

describe("AI 建议卡也能单独改", () => {
  it("channelOwnerName 给名字就钉住这一位", async () => {
    const r = await applyProposal({
      id: "p1", kind: "update_customer", customerId: 老学员, customerName: "老学员", reason: "登记错了",
      changes: [{ field: "channelOwnerName", value: "李蔚然" }],
    });
    expect(r.ok).toBe(true);
    expect((await 读(老学员)).channelOwnerId).toBe(李蔚然);
  });

  it("重名的负责人不猜", async () => {
    await prisma.user.create({ data: { email: "d@t", name: "李蔚然", role: "SALES", password: "x" } });
    const r = await applyProposal({
      id: "p2", kind: "update_customer", customerId: 老学员, customerName: "老学员", reason: "x",
      changes: [{ field: "channelOwnerName", value: "李蔚然" }],
    });
    expect(r.ok).toBe(false);
    expect((await 读(老学员)).channelOwnerId).toBe(张沁);
  });
});
