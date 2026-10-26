/**
 * 项目模式的建档向导（projects/actions.ts 建档向导 + lib/project/wizard.ts）。
 * 钉的是「最后一步一笔落库」：成功时客户、主要联系人、项目、首条跟进全有且连好；
 * 开关关着、客户撞号、中途哪一步写失败，都一行不留。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
  开: true,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));
vi.mock("@/lib/sync/dedupe-client", async (原) => ({ ...(await 原<object>()), 问同事: async () => null }));
vi.mock("@/lib/business", async (原) => {
  const m = await 原<typeof import("@/lib/business")>();
  return { ...m, getBusiness: async () => ({ ...(await m.getBusiness()), projectMode: mocks.开 }) };
});

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 建档向导, 删除项目, type 建档向导输入 } from "@/app/(app)/projects/actions";
import { saveCustomer, deleteCustomers, 客户删除预检 } from "@/app/(app)/customers/actions";
import { 规整向导 } from "@/lib/project/wizard";
import { 默认组织规则 } from "@/lib/project/org-rules";
import { setSetting, invalidateSettingsCache } from "@/lib/settings";

let 甲: string;
let 乙: string;

function 输入(补: Partial<建档向导输入> = {}): 建档向导输入 {
  return {
    客户: {
      name: "向导客户", phone: "13900000001", school: null, grade: null, major: null,
      followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null, remark: null,
      salesOwnerId: 甲, channelId: null, referrerCustomerId: null,
    },
    联系人: { name: " 王经理 ", position: "采购", phone: "13900000002" },
    项目: { name: " 一期改造 ", amount: 12000, currency: "CNY" },
    跟进: { type: "PHONE", content: "电话聊了需求", occurredAt: "2026-10-20 10:00" },
    ...补,
  };
}

async function 各表行数() {
  const [customer, contact, project, log, followUp, link, creator] = await Promise.all([
    prisma.customer.count(), prisma.contact.count(), prisma.project.count(), prisma.projectNodeLog.count(),
    prisma.followUp.count(), prisma.followUpProject.count(), prisma.customerCreator.count(),
  ]);
  return { customer, contact, project, log, followUp, link, creator };
}
const 全空 = { customer: 0, contact: 0, project: 0, log: 0, followUp: 0, link: 0, creator: 0 };

afterEach(() => { vi.unstubAllEnvs(); });

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  mocks.开 = true;
  甲 = (await prisma.user.create({ data: { email: "jia", name: "甲", title: "", role: "ADMIN", password: "x" } })).id;
  乙 = (await prisma.user.create({ data: { email: "yi", name: "乙", title: "", role: "SALES", password: "x" } })).id;
  mocks.user = { ...mocks.user, id: 甲, role: "ADMIN" };
});

describe("建档向导", () => {
  it("一笔建好：客户、主要联系人、项目落在潜客培育并记一行、首条跟进挂上项目和联系人", async () => {
    const r = await 建档向导(输入({ 项目: { name: " 一期改造 ", ownerId: 乙, amount: 12000, currency: "CNY" } }));
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const p = await prisma.project.findUniqueOrThrow({ where: { id: r.projectId }, include: { contact: true } });
    expect(p).toMatchObject({
      name: "一期改造", customerId: r.customerId, ownerId: 乙, creatorId: 甲,
      phase: "线索", node: "潜客培育", result: null, amount: 12000, currency: "CNY",
    });
    expect(p.contact).toMatchObject({ name: "王经理", position: "采购", isPrimary: true, customerId: r.customerId });
    const logs = await prisma.projectNodeLog.findMany({ where: { projectId: p.id } });
    expect(logs).toMatchObject([{ fromNode: null, toPhase: "线索", toNode: "潜客培育", userId: 甲 }]);
    const f = await prisma.followUp.findFirstOrThrow({ include: { projectNode: true } });
    expect(f).toMatchObject({ customerId: r.customerId, contactId: p.contactId, ownerId: 甲, type: "PHONE", content: "电话聊了需求" });
    expect(f.projectNode).toMatchObject({ projectId: p.id, node: "潜客培育" });
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: r.customerId } });
    expect(c.lastFollowAt).toEqual(f.occurredAt);
    expect(await prisma.customerCreator.count({ where: { customerId: r.customerId, userId: 甲 } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entity: "Project", entityId: p.id } })).toBe(1);
  });

  it("负责人没选 = 自己", async () => {
    const r = await 建档向导(输入());
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect((await prisma.project.findUniqueOrThrow({ where: { id: r.projectId } })).ownerId).toBe(甲);
  });

  describe("下一步时间（企业版超时回收）", () => {
    const 开着超时 = { ...默认组织规则, 超时回收: { 开: true, 节点天数: { 潜客培育: 7 } } };
    const 带下一步 = (下一步时间: string) => 输入({ 跟进: { type: "PHONE", content: "电话聊了需求", occurredAt: "2026-10-20 10:00", 下一步时间 } });
    const 项目的 = async (r: Awaited<ReturnType<typeof 建档向导>>) => r.ok ? (await prisma.project.findUniqueOrThrow({ where: { id: r.projectId } })).nextStepAt : "没建成";

    it("不是企业版：Setting 里开着也不要、老草稿里留着的（过期的也一样）不认，项目不写下一步时间", async () => {
      await setSetting("orgRules", 开着超时);
      expect(await 项目的(await 建档向导(输入()))).toBeNull();
      expect(await 项目的(await 建档向导({ ...带下一步("2099-01-01"), 客户: { ...输入().客户, phone: "13900000011" } }))).toBeNull();
      expect(await 项目的(await 建档向导({ ...带下一步("2020-01-01"), 客户: { ...输入().客户, phone: "13900000012" } }))).toBeNull();
    });

    it("企业版开了超时回收：不填拦，填了写上项目", async () => {
      vi.stubEnv("CRM_ENTERPRISE", "1");
      await setSetting("orgRules", 开着超时);
      expect(await 建档向导(输入())).toMatchObject({ ok: false, error: expect.stringContaining("下一步时间") });
      const 下一步 = await 项目的(await 建档向导(带下一步("2099-01-01")));
      expect(下一步 && typeof 下一步 !== "string" && 下一步.getFullYear()).toBe(2099);
    });
  });

  it("开关关着：拦下，一行不写", async () => {
    mocks.开 = false;
    expect(await 建档向导(输入())).toMatchObject({ ok: false, error: expect.stringContaining("项目模式没开") });
    expect(await 各表行数()).toEqual(全空);
  });

  it("负责人停用了：拦下，一行不写", async () => {
    await prisma.user.update({ where: { id: 乙 }, data: { active: false } });
    expect(await 建档向导(输入({ 项目: { name: "x", ownerId: 乙 } }))).toMatchObject({ ok: false, error: expect.stringContaining("负责人") });
    expect(await 各表行数()).toEqual(全空);
  });

  it("持有上限开着（企业版）：给到了上限的人建拦下、一行不写；建给自己不拦", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "1");
    await setSetting("orgRules", { 公海: { 持有上限开: true, 默认上限: 1 } });
    const 客 = await prisma.customer.create({ data: { name: "老客户", phone: "13900000009", salesOwnerId: 甲 } });
    await prisma.project.create({ data: { name: "已有", customerId: 客.id, ownerId: 乙, creatorId: 乙 } });
    await prisma.project.create({ data: { name: "已有", customerId: 客.id, ownerId: 甲, creatorId: 甲 } });
    const 前 = await 各表行数();
    expect(await 建档向导(输入({ 项目: { name: "x", ownerId: 乙 } }))).toMatchObject({ ok: false, error: expect.stringContaining("持有上限") });
    expect(await 各表行数()).toEqual(前);
    expect(await 建档向导(输入())).toMatchObject({ ok: true });
  });

  it("不是企业版：Setting 里持有上限开着也不拦", async () => {
    await setSetting("orgRules", { 公海: { 持有上限开: true, 默认上限: 1 } });
    const 客 = await prisma.customer.create({ data: { name: "老客户", phone: "13900000009", salesOwnerId: 甲 } });
    await prisma.project.create({ data: { name: "已有", customerId: 客.id, ownerId: 乙, creatorId: 乙 } });
    expect(await 建档向导(输入({ 项目: { name: "x", ownerId: 乙 } }))).toMatchObject({ ok: true });
  });

  it("客户撞号：saveCustomer 拦下，联系人、项目、跟进都不建", async () => {
    await prisma.customer.create({ data: { name: "老客户", phone: "13900000001", salesOwnerId: 甲 } });
    const r = await 建档向导(输入());
    expect(r).toMatchObject({ ok: false });
    expect(await 各表行数()).toEqual({ ...全空, customer: 1 });
  });

  it("中途写失败（首条跟进挂不上人）：整笔回滚，客户、联系人、项目、节点变更、建档人一行不留", async () => {
    mocks.user.id = "已经不在的人";
    const r = await 建档向导(输入({ 项目: { name: "一期改造", ownerId: 乙 } }));
    // 客户、联系人、项目都已写进事务，到 followUp.create 才撞外键
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("关联数据已变化") });
    expect(await 各表行数()).toEqual(全空);
  });

  it("从浏览器塞给 saveCustomer 的别的函数一律当没给", async () => {
    let 跑了 = false;
    const r = await saveCustomer(输入().客户, async () => { 跑了 = true; });
    expect(r).toMatchObject({ ok: true });
    expect(跑了).toBe(false);
    expect(await 各表行数()).toMatchObject({ customer: 1, project: 0, contact: 0 });
  });
});

describe("企业版：联系人那一步的号码也查重（验收 #3）", () => {
  beforeEach(() => { vi.stubEnv("CRM_ENTERPRISE", "1"); });
  const 乙的客户 = async () => {
    const c = await prisma.customer.create({ data: { name: "乙的客户", phone: "13900000008", salesOwnerId: 乙 } });
    await prisma.customerExtra.create({ data: { customerId: c.id, email: "Wang@Corp.com" } });
  };

  it("联系人邮箱撞到同事客户档案上的：拦下，说是哪一格、找谁，一行不写", async () => {
    await 乙的客户();
    const r = await 建档向导(输入({ 联系人: { name: "王经理", email: " wang@corp.COM " } }));
    expect(r).toEqual({ ok: false, error: "联系人邮箱：⛔号码重复，可与 乙 沟通核实" });
    expect(await 各表行数()).toEqual({ ...全空, customer: 1 });
    expect(await prisma.contactMethod.count()).toBe(0);
  });

  it("联系人电话格式不对：拦下，一行不写", async () => {
    const r = await 建档向导(输入({ 联系人: { name: "王经理", phone: "1390000" } }));
    expect(r).toEqual({ ok: false, error: "联系人电话：⚠️手机号格式错误" });
    expect(await 各表行数()).toEqual(全空);
  });

  it("建好：联系人的号记进子表并挂上联系人；跟第一步同一个号不算自己撞自己", async () => {
    const r = await 建档向导(输入({
      客户: { ...输入().客户, phone: "13900000003", 企业号码: { 类型: "手机号", 值: "139 0000 0003" } },
      联系人: { name: "王经理", phone: "13900000003", email: "Wang@Corp.com", wechat: "WangLi_88" },
    }));
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const p = await prisma.project.findUniqueOrThrow({ where: { id: r.projectId } });
    const 行 = await prisma.contactMethod.findMany({ orderBy: { kind: "asc" }, select: { customerId: true, contactId: true, kind: true, numberKey: true } });
    expect(行).toEqual([
      { customerId: r.customerId, contactId: p.contactId, kind: "email", numberKey: "wang@corp.com" },
      { customerId: r.customerId, contactId: p.contactId, kind: "phone", numberKey: "13900000003" },
      { customerId: r.customerId, contactId: p.contactId, kind: "wechat", numberKey: "wangli_88" },
    ]);
  });
});

describe("开关关着：联系人那一步照旧不查重", () => {
  it("联系人邮箱跟同事的撞了也照样建，不写子表", async () => {
    const c = await prisma.customer.create({ data: { name: "乙的客户", phone: "13900000008", salesOwnerId: 乙 } });
    await prisma.customerExtra.create({ data: { customerId: c.id, email: "wang@corp.com" } });
    expect(await 建档向导(输入({ 联系人: { name: "王经理", email: "wang@corp.com", phone: "1390000" } }))).toMatchObject({ ok: true });
    expect(await prisma.contactMethod.count()).toBe(0);
  });
});

describe("有项目的客户不让删", () => {
  it("预检和真删都拦；同事删不了别人的项目；项目删掉后跟进还在，客户就能删了", async () => {
    const r = await 建档向导(输入());
    if (!r.ok) throw new Error(r.error);
    expect(await 客户删除预检([r.customerId])).toMatchObject({ ok: false, error: expect.stringMatching(/名下还有 1 个项目，先删项目再删/) });
    expect(await deleteCustomers([r.customerId])).toMatchObject({ ok: false, error: expect.stringContaining("向导客户") });
    expect(await prisma.project.count()).toBe(1);

    mocks.user = { ...mocks.user, id: 乙, role: "SALES" };
    expect(await 删除项目(r.projectId)).toMatchObject({ ok: false });
    mocks.user = { ...mocks.user, id: 甲, role: "ADMIN" };
    expect(await 删除项目(r.projectId)).toEqual({ ok: true });
    expect(await 各表行数()).toMatchObject({ project: 0, log: 0, link: 0, followUp: 1 });
    expect(await deleteCustomers([r.customerId])).toMatchObject({ ok: true, deleted: 1 });
  });

  it("开关关着删不了项目", async () => {
    const r = await 建档向导(输入());
    if (!r.ok) throw new Error(r.error);
    mocks.开 = false;
    expect(await 删除项目(r.projectId)).toMatchObject({ ok: false, error: expect.stringContaining("没开") });
  });
});

describe("规整向导", () => {
  const me = { id: "me" };
  const now = new Date("2026-10-23T12:00:00");
  const 好的 = () => ({ 联系人: { name: "王" }, 项目: { name: "项目" }, 跟进: { type: "PHONE", content: "聊了", occurredAt: "2026-10-22 09:00" } });

  it("缺省：负责人 = 自己，金额 0，默认币种", () => {
    expect(规整向导(me, 好的(), now)).toMatchObject({ 项目: { ownerId: "me", amount: 0, currency: expect.any(String) } });
  });

  it.each([
    ["联系人没名字", { 联系人: { name: "  " } }, "联系人姓名"],
    ["电话带 *", { 联系人: { name: "王", phone: "139****0001" } }, "*"],
    ["项目没名字", { 项目: { name: "" } }, "项目名称"],
    ["项目名太长", { 项目: { name: "长".repeat(61) } }, "60"],
    ["金额负数", { 项目: { name: "x", amount: -1 } }, "负数"],
    ["金额不是数", { 项目: { name: "x", amount: NaN } }, "负数"],
    ["币种认不出", { 项目: { name: "x", currency: "XXX" } }, "币种"],
    ["备注太长", { 项目: { name: "x", remark: "长".repeat(501) } }, "500"],
    ["首条跟进选了待办", { 跟进: { type: "TASK", content: "x", occurredAt: "2026-10-22 09:00" } }, "不能选"],
    ["沟通内容空", { 跟进: { type: "PHONE", content: " ", occurredAt: "2026-10-22 09:00" } }, "沟通内容"],
    ["时间认不出", { 跟进: { type: "PHONE", content: "x", occurredAt: "昨天" } }, "格式"],
    ["时间在未来", { 跟进: { type: "PHONE", content: "x", occurredAt: "2026-10-24 09:00" } }, "未来"],
  ])("%s → 拦", (_, 改, 说) => {
    expect(规整向导(me, { ...好的(), ...改 } as never, now)).toEqual({ error: expect.stringContaining(说) });
  });

  it("少一整块 → 让从头再走", () => {
    expect(规整向导(me, { 联系人: { name: "王" } } as never, now)).toEqual({ error: expect.stringContaining("从头") });
  });
});
