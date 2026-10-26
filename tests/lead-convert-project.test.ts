/**
 * 企业版项目模式下线索转化顺手建项目（10-25 F6，lib/project/from-lead.ts）。
 * 钉的是：企业版 + 项目模式 → 转客户 / 并到已有客户都建一个项目（线索名、线索负责人、主要联系人、第一个节点、一行节点变更、一条操作记录）；
 * 撞号、超持有上限时什么都不建；不是企业版或没开项目模式 → 和原来一样只转客户。
 * 10-26 验收 #13：企业版转化必须带首条跟进——跟进挂到项目第一个节点、下一步时间写到项目、项目记来源线索；
 * 没带跟进 / 开了超时回收没填下一步时间 → 什么都不建。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
  开: true,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/app/(app)/leads/LeadsView", () => ({ default: () => null }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));
vi.mock("@/lib/business", async (原) => {
  const m = await 原<typeof import("@/lib/business")>();
  return { ...m, getBusiness: async () => ({ ...(await m.getBusiness()), projectMode: mocks.开 }) };
});

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { convertLead, mergeLeadInto } from "@/app/(app)/leads/actions";
import LeadsPage from "@/app/(app)/leads/page";
import { 第一个节点 } from "@/lib/project/nodes";
import { setSetting, invalidateSettingsCache } from "@/lib/settings";
import { 默认组织规则 } from "@/lib/project/org-rules";
import { dayjs } from "@/lib/utils";

let 甲: string;
let 乙: string;

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  mocks.开 = true;
  vi.stubEnv("CRM_ENTERPRISE", "1");
  甲 = (await prisma.user.create({ data: { email: "jia", name: "甲", title: "", role: "ADMIN", password: "x" } })).id;
  乙 = (await prisma.user.create({ data: { email: "yi", name: "乙", title: "", role: "SALES", password: "x" } })).id;
  mocks.user = { ...mocks.user, id: 甲, role: "ADMIN" };
});
afterEach(() => vi.unstubAllEnvs());

const 首条 = (下一步时间: string | null = null) => ({ type: "PHONE", content: "聊了需求", occurredAt: dayjs().subtract(1, "hour").format("YYYY-MM-DD HH:mm"), 下一步时间 });

const 线索 = (data: { name?: string; phone?: string; contact?: string | null; ownerId?: string | null } = {}) =>
  prisma.lead.create({ data: { name: "绍兴华纺实业", phone: "13800001111", contact: "王经理", ownerId: 乙, ...data } });

describe("企业版 + 项目模式", () => {
  it("转客户顺手建项目：线索名、线索负责人、主要联系人、第一个节点，记一行节点变更和一条操作记录", async () => {
    const l = await 线索();
    const r = await convertLead(l.id, 首条());
    if (!r.ok) throw Error(r.error);
    expect(r.projectId).toBeTruthy();
    const p = await prisma.project.findUniqueOrThrow({ where: { id: r.projectId! }, include: { contact: true, logs: true } });
    expect(p).toMatchObject({ name: "绍兴华纺实业", customerId: r.customerId, ownerId: 乙, creatorId: 甲, phase: 第一个节点.phase, node: 第一个节点.node, result: null, amount: 0 });
    expect(p.contact).toMatchObject({ name: "王经理", isPrimary: true, customerId: r.customerId });
    expect(p.logs.map((x) => [x.userId, x.toPhase, x.toNode])).toEqual([[甲, 第一个节点.phase, 第一个节点.node]]);
    expect(await prisma.auditLog.count({ where: { entity: "Project", entityId: p.id, action: "create" } })).toBe(1);
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).toMatchObject({ status: "已转化", customerId: r.customerId });
  });

  it("没联系人、没负责人：项目照建，联系人空着，负责人是转的人；线索名超长截到 60 字", async () => {
    const l = await 线索({ contact: null, ownerId: null, name: "长".repeat(80) });
    const r = await convertLead(l.id, 首条());
    if (!r.ok) throw Error(r.error);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: r.projectId! } })).toMatchObject({ contactId: null, ownerId: 甲, name: "长".repeat(60) });
  });

  it("撞号：客户、项目都不建；并到那位客户时给他建项目", async () => {
    const c = await prisma.customer.create({ data: { name: "老客户", phone: "13800001111", salesOwnerId: 甲, contacts: { create: { name: "老联系人", isPrimary: true } } } });
    const l = await 线索();
    const r = await convertLead(l.id, 首条());
    expect(r).toMatchObject({ ok: false, 撞号: { 能并: true } });
    expect(await prisma.project.count()).toBe(0);
    const m = await mergeLeadInto(l.id, c.id, 首条());
    if (!m.ok) throw Error(m.error);
    const p = await prisma.project.findUniqueOrThrow({ where: { id: m.projectId! }, include: { contact: true } });
    expect(p).toMatchObject({ customerId: c.id, ownerId: 乙, node: 第一个节点.node });
    expect(p.contact?.name).toBe("老联系人");
    expect(p.sourceLeadId).toBe(l.id);
    expect(await prisma.projectNodeLog.count({ where: { projectId: p.id } })).toBe(1);
    expect(await prisma.followUpProject.count({ where: { projectId: p.id, node: 第一个节点.node } })).toBe(1);
  });

  it("线索负责人到了持有上限：整个不转，客户、项目都不建，线索不动", async () => {
    await setSetting("orgRules", { 公海: { 持有上限开: true, 默认上限: 1 } });
    invalidateSettingsCache();
    const c = await prisma.customer.create({ data: { name: "别家", phone: "13900000000", salesOwnerId: 乙 } });
    await prisma.project.create({ data: { name: "手上一个", customerId: c.id, ownerId: 乙, creatorId: 乙 } });
    const l = await 线索();
    expect(await convertLead(l.id, 首条())).toMatchObject({ ok: false, error: expect.stringContaining("持有上限（1 个）") });
    expect(await prisma.customer.count()).toBe(1);
    expect(await prisma.project.count()).toBe(1);
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).toMatchObject({ customerId: null, convertedAt: null });
  });

  it("首条跟进（#13）：挂到项目第一个节点，下一步时间、来源线索写到项目，客户最后跟进时间跟上", async () => {
    const l = await 线索();
    const 下一步 = dayjs().add(3, "day").format("YYYY-MM-DD");
    const r = await convertLead(l.id, 首条(下一步));
    if (!r.ok) throw Error(r.error);
    const p = await prisma.project.findUniqueOrThrow({ where: { id: r.projectId! }, include: { followUps: { include: { followUp: true } } } });
    expect(p.sourceLeadId).toBe(l.id);
    expect(dayjs(p.nextStepAt).format("YYYY-MM-DD")).toBe(下一步);
    expect(p.followUps).toHaveLength(1);
    expect(p.followUps[0]).toMatchObject({ node: 第一个节点.node, followUp: { type: "PHONE", content: "聊了需求", customerId: r.customerId, contactId: p.contactId, ownerId: 甲 } });
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: r.customerId } });
    expect(c.lastFollowAt?.getTime()).toBe(p.followUps[0].followUp.occurredAt.getTime());
  });

  it("没开超时回收时下一步时间选填：不填也转，项目上下一步空着", async () => {
    const r = await convertLead((await 线索()).id, 首条());
    if (!r.ok) throw Error(r.error);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: r.projectId! } })).nextStepAt).toBeNull();
  });

  it("没带首条跟进、内容空着：整个不转，客户、项目、跟进都不建，线索不动", async () => {
    const l = await 线索();
    expect(await convertLead(l.id)).toMatchObject({ ok: false, error: expect.stringContaining("首条跟进") });
    expect(await convertLead(l.id, { ...首条(), content: "  " })).toMatchObject({ ok: false, error: expect.stringContaining("沟通内容") });
    expect(await prisma.customer.count()).toBe(0);
    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.followUp.count()).toBe(0);
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).toMatchObject({ customerId: null, convertedAt: null });
  });

  it("开了超时回收：没填下一步时间不转，并到已有客户也不并", async () => {
    await setSetting("orgRules", { ...默认组织规则, 超时回收: { 开: true, 节点天数: {} } });
    invalidateSettingsCache();
    const l = await 线索();
    expect(await convertLead(l.id, 首条())).toMatchObject({ ok: false, error: expect.stringContaining("下一步时间") });
    const c = await prisma.customer.create({ data: { name: "老客户", phone: "13600000000", salesOwnerId: 甲 } });
    const l2 = await 线索({ phone: "13600000000" });
    expect(await mergeLeadInto(l2.id, c.id, 首条())).toMatchObject({ ok: false, error: expect.stringContaining("下一步时间") });
    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.followUp.count()).toBe(0);
    const ok = await convertLead(l.id, 首条(dayjs().add(1, "day").format("YYYY-MM-DD")));
    expect(ok.ok).toBe(true);
  });
});

describe("开关关着：和原来一样只转客户", () => {
  it("不是企业版（项目模式开着）不建项目", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    const r = await convertLead((await 线索()).id);
    expect(r).toEqual({ ok: true, customerId: expect.any(String) });
    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { entity: "Project" } })).toBe(0);
  });

  it("企业版但没开项目模式不建项目；并到已有客户也不建", async () => {
    mocks.开 = false;
    const r = await convertLead((await 线索()).id);
    expect(r).toEqual({ ok: true, customerId: expect.any(String) });
    const c = await prisma.customer.create({ data: { name: "老客户", phone: "13700000000", salesOwnerId: 甲 } });
    const l = await 线索({ phone: "13700000000" });
    expect(await mergeLeadInto(l.id, c.id)).toEqual({ ok: true, customerId: c.id });
    expect(await prisma.project.count()).toBe(0);
  });
});

describe("线索页交给界面的「企业版项目」（F1：只有它为真，新建线索才不跳建档向导）", () => {
  const 交出 = async () => ((await LeadsPage({ searchParams: Promise.resolve({}) })) as unknown as { props: { 企业版项目: boolean } }).props.企业版项目;
  it("企业版 + 项目模式 → 真", async () => { expect(await 交出()).toBe(true); });
  it("不是企业版 → 假；没开项目模式 → 假", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    expect(await 交出()).toBe(false);
    vi.stubEnv("CRM_ENTERPRISE", "1");
    mocks.开 = false;
    expect(await 交出()).toBe(false);
  });
});
