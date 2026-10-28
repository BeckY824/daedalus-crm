/**
 * 企业版项目模式下线索转化顺手建项目（10-25 F6，lib/project/from-lead.ts）。
 * 钉的是：企业版 + 项目模式 → 转客户 / 并到已有客户都建一个项目（线索名、线索负责人、主要联系人、第一个节点、一行节点变更、一条操作记录）；
 * 撞号、超持有上限时什么都不建；团队版开了项目模式一样建（10-28）；没开项目模式 → 和原来一样只转客户。
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

const 线索 = (data: { name?: string; phone?: string; contact?: string | null; ownerId?: string | null } = {}) =>
  prisma.lead.create({ data: { name: "绍兴华纺实业", phone: "13800001111", contact: "王经理", ownerId: 乙, ...data } });

describe("企业版 + 项目模式", () => {
  it("转客户顺手建项目：线索名、线索负责人、主要联系人、第一个节点，记一行节点变更和一条操作记录", async () => {
    const l = await 线索();
    const r = await convertLead(l.id);
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
    const r = await convertLead(l.id);
    if (!r.ok) throw Error(r.error);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: r.projectId! } })).toMatchObject({ contactId: null, ownerId: 甲, name: "长".repeat(60) });
  });

  it("撞号：客户、项目都不建；并到那位客户时给他建项目", async () => {
    const c = await prisma.customer.create({ data: { name: "老客户", phone: "13800001111", salesOwnerId: 甲, contacts: { create: { name: "老联系人", isPrimary: true } } } });
    const l = await 线索();
    const r = await convertLead(l.id);
    expect(r).toMatchObject({ ok: false, 撞号: { 能并: true } });
    expect(await prisma.project.count()).toBe(0);
    const m = await mergeLeadInto(l.id, c.id);
    if (!m.ok) throw Error(m.error);
    const p = await prisma.project.findUniqueOrThrow({ where: { id: m.projectId! }, include: { contact: true } });
    expect(p).toMatchObject({ customerId: c.id, ownerId: 乙, node: 第一个节点.node });
    expect(p.contact?.name).toBe("老联系人");
    expect(await prisma.projectNodeLog.count({ where: { projectId: p.id } })).toBe(1);
  });

  it("线索负责人到了持有上限：整个不转，客户、项目都不建，线索不动", async () => {
    await setSetting("orgRules", { 公海: { 持有上限开: true, 默认上限: 1 } });
    invalidateSettingsCache();
    const c = await prisma.customer.create({ data: { name: "别家", phone: "13900000000", salesOwnerId: 乙 } });
    await prisma.project.create({ data: { name: "手上一个", customerId: c.id, ownerId: 乙, creatorId: 乙 } });
    const l = await 线索();
    expect(await convertLead(l.id)).toMatchObject({ ok: false, error: expect.stringContaining("持有上限（1 个）") });
    expect(await prisma.customer.count()).toBe(1);
    expect(await prisma.project.count()).toBe(1);
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).toMatchObject({ customerId: null, convertedAt: null });
  });
});

describe("团队版（不是企业版）+ 项目模式：一样建项目（10-28）", () => {
  it("转客户顺手建项目，落在第一个节点，记一行节点变更", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    const r = await convertLead((await 线索()).id);
    if (!r.ok) throw Error(r.error);
    const p = await prisma.project.findUniqueOrThrow({ where: { id: r.projectId! } });
    expect(p).toMatchObject({ customerId: r.customerId, ownerId: 乙, node: 第一个节点.node });
    expect(await prisma.projectNodeLog.count({ where: { projectId: p.id } })).toBe(1);
  });
});

describe("开关关着：和原来一样只转客户", () => {

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

describe("线索页交给界面的「项目模式」（只看开关，企业版、团队版一样）", () => {
  const 交出 = async () => ((await LeadsPage({ searchParams: Promise.resolve({}) })) as unknown as { props: { 项目模式: boolean } }).props.项目模式;
  it("开着 → 真；团队版也真", async () => {
    expect(await 交出()).toBe(true);
    vi.stubEnv("CRM_ENTERPRISE", "");
    expect(await 交出()).toBe(true);
  });
  it("没开项目模式 → 假", async () => {
    mocks.开 = false;
    expect(await 交出()).toBe(false);
  });
});
