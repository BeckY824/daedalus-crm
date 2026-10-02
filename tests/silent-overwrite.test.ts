/**
 * 「悄悄改坏数据」那一档（2026-10-01 逐页排查的 A 档，见 ~/CRM/逐页功能与数据关系排查-2026-10-01.md）。
 *
 * 共同点：用户只做了一件小事（改备注、改年级、改一笔签约的备注……），
 * 别的字段被悄悄换掉，界面只说「已保存」。这里每条钉一个具体场景。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { saveCustomer, saveContract } from "@/app/(app)/customers/actions";
import { resolveAttribution } from "@/lib/attribution";
import { 推荐方式 } from "@/lib/referrer-kind";
import { applyProposal } from "@/app/(app)/dashboard/apply";
import { convertLead } from "@/app/(app)/leads/actions";
import { 查电话, 认回打码号 } from "@/lib/phone";
import { saveContact, detachContact, saveUnassignedContact } from "@/app/(app)/customers/[id]/actions";

let 甲: { id: string };
let 乙: { id: string };

beforeEach(async () => {
  await resetDb();
  甲 = await prisma.user.create({ data: { email: "a@x", name: "甲", title: "销售", role: "ADMIN", password: "x" } });
  乙 = await prisma.user.create({ data: { email: "b@x", name: "乙", title: "销售", role: "SALES", password: "x" } });
  mocks.user.id = 甲.id;
});

afterAll(async () => { await prisma.$disconnect(); });

/** 打开编辑框那一刻表单里有的东西（和 tests/concurrency.test.ts 同一个样子） */
async function 打开(id: string) {
  const r = await prisma.customer.findUniqueOrThrow({ where: { id } });
  const base = {
    name: r.name, phone: r.phone, school: r.school, grade: r.grade, major: r.major,
    followStatus: r.followStatus, decisionStatus: r.decisionStatus,
    expectedSignAt: r.expectedSignAt, remark: r.remark, salesOwnerId: r.salesOwnerId,
    channelId: r.channelId, referrerCustomerId: r.referrerCustomerId, channelOwnerId: r.channelOwnerId,
  };
  return { id, updatedAt: r.updatedAt.toISOString(), base };
}

/** 小红(渠道，乙负责) → 小明 → 室友：室友是转介绍来的，channelId 继承链顶的小红 */
async function 造推荐链() {
  const 小红 = await prisma.channel.create({ data: { name: "小红", channelOwnerId: 乙.id } });
  const a1 = await resolveAttribution({ channelId: 小红.id });
  const 小明 = await prisma.customer.create({ data: { name: "小明", phone: "13800000001", salesOwnerId: 甲.id, ...a1 } });
  const a2 = await resolveAttribution({ referrerCustomerId: 小明.id });
  const 室友 = await prisma.customer.create({
    data: { name: "室友", phone: "13800000002", salesOwnerId: 甲.id, referrerCustomerId: 小明.id, ...a2 },
  });
  return { 小红, 小明, 室友 };
}

describe("A1 编辑转介绍来的客户，只改备注，推荐人不能被换掉", () => {
  it("推荐方式先看推荐人：转介绍的人 channelId 也有值，不能认成「外部渠道」", async () => {
    const { 室友, 小红 } = await 造推荐链();
    const r = await prisma.customer.findUniqueOrThrow({ where: { id: 室友.id } });
    expect(r.channelId).toBe(小红.id); // 继承了链顶的渠道——这正是原来被误判的原因
    expect(推荐方式(r)).toBe("customer");
    expect(推荐方式({ channelId: 小红.id, referrerCustomerId: null })).toBe("channel");
    expect(推荐方式({ channelId: null, referrerCustomerId: null })).toBe("none");
    expect(推荐方式(null)).toBe("none");
  });

  it("表单在「已有客户」那一档提交（渠道传 null），只改备注：推荐人、归属、渠道负责人原样", async () => {
    const { 室友, 小明 } = await 造推荐链();
    const 改前 = await prisma.customer.findUniqueOrThrow({ where: { id: 室友.id } });
    // 期间有人单独订正了小明的渠道负责人：室友没动推荐链，不该被重算过去（09 月拍板「谁的数据没动，谁的归属就不变」）
    await prisma.customer.update({ where: { id: 小明.id }, data: { channelOwnerId: 甲.id } });

    const f = await 打开(室友.id);
    // 表单没动「渠道负责人」那一格就不传它（A4）：这里也不传，否则它会被当成手工指定、把问题遮住
    const { channelOwnerId: _没动, ...表单值 } = f.base;
    const res = await saveCustomer({
      ...表单值, id: f.id, updatedAt: f.updatedAt, base: f.base,
      channelId: null, referrerCustomerId: 小明.id, remark: "改个备注",
    } as Parameters<typeof saveCustomer>[0]);
    expect(res.ok).toBe(true);

    const 改后 = await prisma.customer.findUniqueOrThrow({ where: { id: 室友.id } });
    expect(改后.remark).toBe("改个备注");
    expect(改后).toMatchObject({
      referrerCustomerId: 小明.id,
      channelId: 改前.channelId,
      attributionChannelId: 改前.attributionChannelId,
      attributionCustomerId: 改前.attributionCustomerId,
      channelOwnerId: 改前.channelOwnerId,
    });
  });
});

describe("A2 共享试用区：表单交回打码的号码，不能当真号写进库", () => {
  it("带 * 的不算号码；正是原号打码的样子就认回原号", () => {
    expect(查电话("138****1111", { 必填: true })).toMatchObject({ ok: false });
    expect(认回打码号("138****1111", "13800001111")).toBe("13800001111");
    expect(认回打码号("139****1111", "13800001111")).toBe("139****1111"); // 不是原号的码：原样交给校验去拒
    expect(认回打码号("13900002222", "13800001111")).toBe("13900002222"); // 真改了号：照常
  });

  it("客户：只改年级，交回 138****0001，库里还是真号", async () => {
    const c = await prisma.customer.create({ data: { name: "张三", phone: "13800000001", salesOwnerId: 甲.id } });
    const f = await 打开(c.id);
    const { channelOwnerId: _没动, ...表单值 } = f.base;
    const res = await saveCustomer({
      ...表单值, id: f.id, updatedAt: f.updatedAt, base: { ...f.base, phone: "138****0001" },
      phone: "138****0001", grade: "大三",
    } as Parameters<typeof saveCustomer>[0]);
    expect(res.ok).toBe(true);
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ phone: "13800000001", grade: "大三" });
  });

  it("客户：交回一个不是原号打码样子、又带 * 的，拒掉", async () => {
    const c = await prisma.customer.create({ data: { name: "张三", phone: "13800000001", salesOwnerId: 甲.id } });
    const f = await 打开(c.id);
    const { channelOwnerId: _没动, ...表单值 } = f.base;
    const res = await saveCustomer({ ...表单值, id: f.id, updatedAt: f.updatedAt, base: f.base, phone: "139****0001" } as Parameters<typeof saveCustomer>[0]);
    expect(res.ok).toBe(false);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).phone).toBe("13800000001");
  });

  it("联系人和未归属联系人：一样认回原号", async () => {
    const c = await prisma.customer.create({ data: { name: "张三", phone: "13800000001", salesOwnerId: 甲.id } });
    const 王 = await prisma.contact.create({ data: { customerId: c.id, name: "王经理", phone: "13900000001" } });
    expect(await saveContact({ id: 王.id, customerId: c.id, name: "王经理", phone: "139****0001", isPrimary: false, remark: "改备注" })).toMatchObject({ ok: true });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: 王.id } })).phone).toBe("13900000001");

    await detachContact(王.id);
    expect(await saveUnassignedContact({ id: 王.id, name: "王经理", phone: "139****0001", wechat: "wang" })).toMatchObject({ ok: true });
    expect(await prisma.unassignedContact.findUniqueOrThrow({ where: { id: 王.id } })).toMatchObject({ phone: "13900000001", wechat: "wang" });

    expect(await saveUnassignedContact({ id: 王.id, name: "王经理", phone: "137****0001" })).toMatchObject({ ok: false });
  });
});

describe("A5 改一笔旧签约的备注，客户状态不能被改回「已签约」", () => {
  it("新登记推进状态；编辑旧签约不碰", async () => {
    const c = await prisma.customer.create({ data: { name: "张三", phone: "13800000001", salesOwnerId: 甲.id } });
    expect(await saveContract({ customerId: c.id, amount: 10000, signedAt: new Date("2026-09-01"), remark: null })).toMatchObject({ ok: true });
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ followStatus: "已签约", decisionStatus: "已决定报名" });

    // 退费了，人工改成已流失，签约记录留着
    await prisma.customer.update({ where: { id: c.id }, data: { followStatus: "已流失", decisionStatus: "暂不考虑" } });
    const 那笔 = await prisma.contract.findFirstOrThrow({ where: { customerId: c.id } });
    expect(await saveContract({ id: 那笔.id, customerId: c.id, amount: 10000, signedAt: 那笔.signedAt, remark: "已退费" })).toMatchObject({ ok: true });

    expect(await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ followStatus: "已流失", decisionStatus: "暂不考虑" });
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: 那笔.id } })).remark).toBe("已退费");
  });
});

describe("A6 用 AI 卡把推荐人改成某位客户，归属要跟着推荐链走", () => {
  it("原来从渠道 A 来，改成「小明推荐」（小明来自渠道 B）：渠道、归属都按小明那条链", async () => {
    const A = await prisma.channel.create({ data: { name: "渠道A", channelOwnerId: 甲.id } });
    const B = await prisma.channel.create({ data: { name: "渠道B", channelOwnerId: 乙.id } });
    const 小明 = await prisma.customer.create({
      data: { name: "小明", phone: "13800000001", salesOwnerId: 甲.id, ...(await resolveAttribution({ channelId: B.id })) },
    });
    const 张三 = await prisma.customer.create({
      data: { name: "张三", phone: "13800000002", salesOwnerId: 甲.id, ...(await resolveAttribution({ channelId: A.id })) },
    });

    const r = await applyProposal({
      id: "p1", kind: "update_customer", customerId: 张三.id, customerName: "张三", reason: "其实是小明介绍的",
      changes: [{ field: "referrerName", value: "小明" }],
    });
    expect(r.ok).toBe(true);
    const 应该 = await resolveAttribution({ referrerCustomerId: 小明.id });
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: 张三.id } })).toMatchObject({
      referrerCustomerId: 小明.id,
      channelId: B.id,
      attributionChannelId: 应该.attributionChannelId,
      attributionCustomerId: 应该.attributionCustomerId,
      channelOwnerId: 乙.id,
    });
  });
});

describe("A8 线索转客户：手机号先规整再查重", () => {
  it("线索上写「138 0000 1111」，库里已有 13800001111：认出是同一个人，不建第二份", async () => {
    await prisma.customer.create({ data: { name: "老客户", phone: "13800001111", salesOwnerId: 甲.id } });
    const l = await prisma.lead.create({ data: { name: "新线索", phone: "138 0000 1111", ownerId: 甲.id } });
    const r = await convertLead(l.id);
    expect(r.ok).toBe(false);
    expect(await prisma.customer.count()).toBe(1);
  });

  it("没重复的：建出来的客户号码是规整过的", async () => {
    const l = await prisma.lead.create({ data: { name: "新线索", phone: "+86 139-0000-2222", ownerId: 甲.id } });
    expect((await convertLead(l.id)).ok).toBe(true);
    expect((await prisma.customer.findFirstOrThrow()).phone).toBe("13900002222");
  });

  it("号码明显不对：说清楚，不建", async () => {
    const l = await prisma.lead.create({ data: { name: "新线索", phone: "前台转", ownerId: 甲.id } });
    const r = await convertLead(l.id);
    expect(r).toMatchObject({ ok: false });
    expect(await prisma.customer.count()).toBe(0);
  });
});

