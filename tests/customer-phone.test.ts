/**
 * 客户电话的规矩：导入、表单、saveCustomer 同一条（lib/phone.ts）。
 *
 * 2026-09-28 审查 S2：表单用大陆 11 位手机号的正则、而且一律必填，
 * 导进来的海外号 / 座机、演示数据里没电话的人，一编辑就存不了。
 * 这一组钉三件事：
 *   1. 规矩放宽到和导入一样（6–20 位数字，可以带 +）
 *   2. 必填只管新建、和原来就有号码的；原来没电话的人改备注不用先编一个号码
 *   3. **查重没有被放宽**：规整后精确比对照旧拦；空电话不拿来比（两个没留电话的人不是同一个人）
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { saveCustomer, checkDuplicate } from "@/app/(app)/customers/actions";
import { 查电话, 规整手机号, 像手机号 } from "@/lib/phone";
import * as 导入 from "@/lib/import/plan";

let jia: { id: string };

beforeEach(async () => {
  await resetDb();
  jia = await prisma.user.create({ data: { email: "jia", name: "甲", title: "销售", role: "ADMIN", password: "x" } });
  mocks.user = { id: jia.id, name: "甲", email: "jia", role: "ADMIN", title: "管理员", avatar: null };
});
afterAll(async () => { await prisma.$disconnect(); });

const 新建 = (phone: string, name = "新客户") =>
  saveCustomer({
    name, phone, school: null, grade: null, major: null,
    followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null,
    remark: null, salesOwnerId: jia.id, channelId: null, referrerCustomerId: null,
  });

/** 照表单的发法：打开那一刻的整份值原样带回去，只改 patch 里那几项 */
async function 编辑(id: string, patch: Record<string, unknown>) {
  const r = await prisma.customer.findUniqueOrThrow({ where: { id } });
  const base = {
    name: r.name, phone: r.phone, school: r.school, grade: r.grade, major: r.major,
    followStatus: r.followStatus, decisionStatus: r.decisionStatus,
    expectedSignAt: r.expectedSignAt, remark: r.remark, salesOwnerId: r.salesOwnerId,
    channelId: r.channelId, referrerCustomerId: r.referrerCustomerId,
  };
  return saveCustomer({ id, updatedAt: r.updatedAt.toISOString(), base, ...base, ...patch } as Parameters<typeof saveCustomer>[0]);
}

describe("一条规矩，三处共用", () => {
  it("导入那边用的就是这一份，不是另抄一份", () => {
    expect(导入.规整手机号).toBe(规整手机号);
    expect(导入.像手机号).toBe(像手机号);
  });

  it("海外号、座机、带分隔符的都收，规整后存", () => {
    expect(查电话("+1 415 555 0100", { 必填: true })).toEqual({ ok: true, phone: "+14155550100" });
    expect(查电话("010-6552 1234", { 必填: true })).toEqual({ ok: true, phone: "01065521234" });
    expect(查电话("+86 138 0000 1111", { 必填: true })).toEqual({ ok: true, phone: "13800001111" });
  });

  it("号码前后带着字：只取号码；「.0」尾巴去掉、不变成 12 位；打码的不收（2026-10-02 排查）", async () => {
    const { 号码带着字 } = await import("@/lib/phone");
    expect(规整手机号("13800001111（微信同号）")).toBe("13800001111");
    expect(规整手机号("手机:13800001111")).toBe("13800001111");
    expect(规整手机号("138 0000 1111/王总")).toBe("13800001111");
    expect(规整手机号("13800001111.0")).toBe("13800001111");
    expect(规整手机号("+86 138 0000 1111")).toBe("13800001111");
    expect(号码带着字("13800001111（微信同号）")).toBe(true);
    expect(号码带着字("138-0000-1111")).toBe(false);
    expect(号码带着字("13800001111.0")).toBe(false);
    expect(像手机号(规整手机号("138****1111"))).toBe(false);
  });

  it("不像号码的照旧挡：没数字、太短、太长", () => {
    expect(查电话("不详", { 必填: true }).ok).toBe(false);
    expect(查电话("12345", { 必填: true }).ok).toBe(false);
    expect(查电话("1".repeat(21), { 必填: true }).ok).toBe(false);
  });

  it("空着：必填时拦，不必填时收成空串", () => {
    expect(查电话("  ", { 必填: true })).toEqual({ ok: false, error: "请输入联系电话" });
    expect(查电话("", { 必填: false })).toEqual({ ok: true, phone: "" });
    expect(查电话(undefined, { 必填: false })).toEqual({ ok: true, phone: "" });
  });
});

describe("saveCustomer：必填只管新建和原来有号码的", () => {
  it("新建不填电话被拦", async () => {
    const r = await 新建("");
    expect(r.ok).toBe(false);
  });

  it("新建一位海外客户能建（外贸预设下原来根本建不了）", async () => {
    const r = await 新建("+44 20 7946 0958");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: r.id } })).phone).toBe("+442079460958");
  });

  it("原来没电话的两个人：各改备注都能存（原来拿空串查重，互相把对方当成重复）", async () => {
    const a = await prisma.customer.create({ data: { name: "没电话甲", phone: "", salesOwnerId: jia.id } });
    await prisma.customer.create({ data: { name: "没电话乙", phone: "", salesOwnerId: jia.id } });
    const r = await 编辑(a.id, { remark: "只想改一下备注" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: a.id } })).remark).toBe("只想改一下备注");
  });

  it("原来有号码的不许清空——那是认人的依据", async () => {
    const r0 = await 新建("13800000001");
    if (!r0.ok) throw new Error(r0.error);
    const r = await 编辑(r0.id, { phone: "" });
    expect(r.ok).toBe(false);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: r0.id } })).phone).toBe("13800000001");
  });

  it("库里老写法的号码没动就原样留着，不因为改备注被悄悄规整", async () => {
    const c = await prisma.customer.create({ data: { name: "老数据", phone: "138-0000-0009", salesOwnerId: jia.id } });
    const r = await 编辑(c.id, { remark: "改备注" });
    expect(r.ok).toBe(true);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).phone).toBe("138-0000-0009");
  });
});

describe("查重没有被放宽", () => {
  it("换个写法录同一个号码，照样被拦（规整后比）", async () => {
    await 新建("13800000001", "先来的");
    const r = await 新建("+86 138-0000-0001", "后来的");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("先来的");
  });

  it("编辑时把号码改成别人的，被拦", async () => {
    await 新建("13800000001", "先来的");
    const b = await 新建("13800000002", "后来的");
    if (!b.ok) throw new Error(b.error);
    const r = await 编辑(b.id, { phone: "138 0000 0001" });
    expect(r.ok).toBe(false);
  });

  it("失焦时的查重提示也按规整后的号码找", async () => {
    await 新建("13800000001", "先来的");
    expect((await checkDuplicate("138 0000 0001"))?.name).toBe("先来的");
    expect(await checkDuplicate("   ")).toBeNull();
  });
});
