/**
 * 项目详情的编辑项目、项目组，设置里的两个上级（projects/actions.ts）。
 * 钉的是：开关关着一律拦、一行不写；写成了留一条操作记录；没改动不留记录。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
  开: true,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));
vi.mock("@/lib/business", async (原) => {
  const m = await 原<typeof import("@/lib/business")>();
  return { ...m, getBusiness: async () => ({ ...(await m.getBusiness()), projectMode: mocks.开 }) };
});

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 编辑项目, 加项目组员, 换项目组员角色, 移出项目组员, 改组织规则, 预览超时回收, 记项目沟通Action, 回项目邀请 } from "@/app/(app)/projects/actions";
import { 角色字典 } from "@/lib/project/db";
import { 读组织规则 } from "@/lib/project/org-rules-store";
import { invalidateSettingsCache } from "@/lib/settings";

let 甲: string;
let 乙: string;
let 项目id: string;

const 记录 = () => prisma.auditLog.findMany({ orderBy: { at: "asc" }, select: { entity: true, entityId: true, summary: true } });

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  mocks.开 = true;
  甲 = (await prisma.user.create({ data: { email: "jia", name: "甲", title: "", role: "ADMIN", password: "x" } })).id;
  乙 = (await prisma.user.create({ data: { email: "yi", name: "乙", title: "", role: "SALES", password: "x" } })).id;
  mocks.user = { ...mocks.user, id: 甲, role: "ADMIN" };
  const c = await prisma.customer.create({ data: { name: "客户", phone: "13800000001", salesOwnerId: 甲 } });
  项目id = (await prisma.project.create({ data: { name: "一期", customerId: c.id, ownerId: 甲, creatorId: 甲 } })).id;
});

describe("开关关着", () => {
  it("编辑项目、加人、换角色、移出都拦，一行不写", async () => {
    const [r] = await 角色字典();
    const m = await prisma.projectMember.create({ data: { projectId: 项目id, userId: 甲, inviteStatus: "JOINED" } });
    mocks.开 = false;
    for (const x of [
      await 编辑项目(项目id, { name: "二期" }),
      await 加项目组员(项目id, 乙, r.id),
      await 换项目组员角色(m.id, r.id),
      await 移出项目组员(m.id),
    ]) expect(x).toMatchObject({ ok: false, error: expect.stringContaining("没开") });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: 项目id } })).name).toBe("一期");
    expect(await prisma.projectMember.findMany({ select: { userId: true, roleId: true } })).toEqual([{ userId: 甲, roleId: null }]);
    expect(await 记录()).toEqual([]);
  });
});

describe("操作记录", () => {
  it("编辑项目记改了哪几样；没改动不记", async () => {
    expect(await 编辑项目(项目id, { name: "二期", amount: 100 })).toEqual({ ok: true });
    expect(await 编辑项目(项目id, { name: "二期", amount: 100 })).toEqual({ ok: true });
    expect(await 记录()).toEqual([{ entity: "Project", entityId: 项目id, summary: "编辑项目「二期」：改了名称、金额" }]);
  });

  it("项目组加人、换角色、移出各记一条，挂在项目上", async () => {
    const [r] = await 角色字典();
    expect(await 加项目组员(项目id, 乙, null)).toEqual({ ok: true });
    const m = await prisma.projectMember.findFirstOrThrow();
    expect(await 换项目组员角色(m.id, r.id)).toEqual({ ok: true });
    expect(await 换项目组员角色(m.id, r.id)).toEqual({ ok: true });
    expect(await 移出项目组员(m.id)).toEqual({ ok: true });
    expect(await 记录()).toEqual([
      { entity: "ProjectMember", entityId: 项目id, summary: "加进项目「一期」的项目组：乙" },
      { entity: "ProjectMember", entityId: 项目id, summary: `项目「一期」的项目组：乙 角色改成「${r.name}」` },
      { entity: "ProjectMember", entityId: 项目id, summary: "移出项目「一期」的项目组：乙" },
    ]);
  });

});

describe("改组织规则（企业版持有上限）", () => {
  beforeEach(() => { vi.stubEnv("CRM_ENTERPRISE", "1"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("不是企业版：老板也改不了，一行不写", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    expect(await 改组织规则({ 公海: { 持有上限开: true } })).toMatchObject({ ok: false, error: expect.stringContaining("企业版") });
    expect((await 读组织规则()).公海.持有上限开).toBe(false);
    expect(await 预览超时回收({ 超时回收: { 开: true } })).toMatchObject({ ok: false, error: expect.stringContaining("企业版") });
    // 在项目上记沟通也是企业版的：拦下，一条跟进不写（照原来去客户页记）
    expect(await 记项目沟通Action(项目id, { type: "PHONE", content: "聊了", occurredAt: "2026-10-20 10:00" })).toMatchObject({ ok: false, error: expect.stringContaining("企业版") });
    expect(await prisma.followUp.count()).toBe(0);
    expect(await 记录()).toEqual([]);
  });

  it("老板开、设默认和单独上限，存下并留记录；再关", async () => {
    expect(await 改组织规则({ 公海: { 持有上限开: true } })).toEqual({ ok: true, 收回: 0 });
    expect(await 改组织规则({ 公海: { 默认上限: 8, 每人上限: { [乙]: 3 } } })).toEqual({ ok: true, 收回: 0 });
    expect((await 读组织规则()).公海).toEqual({ 持有上限开: true, 默认上限: 8, 每人上限: { [乙]: 3 } });
    expect(await 改组织规则({ 公海: { 持有上限开: false } })).toEqual({ ok: true, 收回: 0 });
    expect((await 读组织规则()).公海).toMatchObject({ 持有上限开: false, 默认上限: 8 });
    expect((await 记录()).map((r) => r.summary)).toEqual([
      "组织规则：项目持有上限开，默认 30 个，单独设了 0 人",
      "组织规则：项目持有上限开，默认 8 个，单独设了 1 人",
      "组织规则：项目持有上限关",
    ]);
  });

  it("超时回收：保存前先看会收回几个，保存后当场收回、返回个数", async () => {
    const p = await prisma.project.update({ where: { id: 项目id }, data: { createdAt: new Date(Date.now() - 10 * 86400_000) } });
    const 改 = { 超时回收: { 开: true, 节点天数: { [p.node]: 3 } } };
    expect(await 预览超时回收(改)).toEqual({ ok: true, 个数: 1, 团队: false });
    expect((await 读组织规则()).超时回收.开).toBe(false);
    expect(await 改组织规则(改)).toEqual({ ok: true, 收回: 1 });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: 项目id } })).pooledAt).not.toBeNull();
    expect((await 记录()).map((r) => r.summary)).toContain("组织规则：超时回收开，设了 1 个节点的处理时长");
    mocks.user = { ...mocks.user, id: 乙, role: "SALES" };
    expect(await 预览超时回收(改)).toMatchObject({ ok: false, error: expect.stringContaining("只有老板") });
  });

  it("节点推进：老板配必填、开关，存下并留记录；配不能配的节点拦", async () => {
    expect(await 改组织规则({ 节点推进: { 开: true, 必填: { 潜客培育: ["联系方式", "来源"], 线索验证: [] } } })).toEqual({ ok: true, 收回: 0 });
    expect((await 读组织规则()).节点推进).toEqual({ 开: true, 必填: { 潜客培育: ["联系方式", "来源"] } });
    expect(await 改组织规则({ 节点推进: { 开: false } })).toEqual({ ok: true, 收回: 0 });
    expect(await 改组织规则({ 节点推进: { 必填: { 尾款结算: ["金额"] } } })).toMatchObject({ ok: false, error: expect.stringContaining("不能配必填") });
    expect((await 记录()).map((r) => r.summary)).toEqual([
      "组织规则：节点推进开，1 个节点配了必填",
      "组织规则：节点推进关",
    ]);
  });

  it("业务员改不了；开关关着拦；填错拦，都不写", async () => {
    mocks.user = { ...mocks.user, id: 乙, role: "SALES" };
    expect(await 改组织规则({ 公海: { 持有上限开: true } })).toMatchObject({ ok: false, error: expect.stringContaining("只有老板") });
    mocks.user = { ...mocks.user, id: 甲, role: "ADMIN" };
    expect(await 改组织规则({ 公海: { 默认上限: 0 } })).toMatchObject({ ok: false, error: expect.stringContaining("1–999") });
    mocks.开 = false;
    expect(await 改组织规则({ 公海: { 持有上限开: true } })).toMatchObject({ ok: false, error: expect.stringContaining("没开") });
    expect((await 读组织规则()).公海.持有上限开).toBe(false);
    expect(await 记录()).toEqual([]);
  });
});

describe("企业版项目组邀请（10-26）", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("邀请记「邀请进」，同意 / 拒绝各记一条；别人替他回不行", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "1");
    expect(await 加项目组员(项目id, 乙, null)).toEqual({ ok: true });
    const m = await prisma.projectMember.findFirstOrThrow({ where: { userId: 乙 } });
    expect(m.inviteStatus).toBe("INVITED");
    expect(await 回项目邀请(m.id, true)).toMatchObject({ ok: false });
    mocks.user = { ...mocks.user, id: 乙, role: "SALES" };
    expect(await 回项目邀请(m.id, false)).toEqual({ ok: true });
    mocks.user = { ...mocks.user, id: 甲, role: "ADMIN" };
    expect(await 加项目组员(项目id, 乙, null)).toEqual({ ok: true });
    mocks.user = { ...mocks.user, id: 乙, role: "SALES" };
    expect(await 回项目邀请(m.id, true)).toEqual({ ok: true });
    expect((await 记录()).map((r) => r.summary)).toEqual([
      expect.stringContaining("邀请进"), expect.stringContaining("拒绝加入"),
      expect.stringContaining("邀请进"), expect.stringContaining("同意加入"),
    ]);
  });

  it("开关关着：回邀请直接拦、一行不写；加人照旧「加进」直接进组", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    expect(await 加项目组员(项目id, 乙, null)).toEqual({ ok: true });
    const m = await prisma.projectMember.findFirstOrThrow({ where: { userId: 乙 } });
    expect(m.inviteStatus).toBe("JOINED");
    mocks.user = { ...mocks.user, id: 乙, role: "SALES" };
    expect(await 回项目邀请(m.id, false)).toMatchObject({ ok: false, error: expect.stringContaining("企业版") });
    expect((await prisma.projectMember.findUniqueOrThrow({ where: { id: m.id } })).inviteStatus).toBe("JOINED");
    expect((await 记录()).map((r) => r.summary)).toEqual([expect.stringContaining("加进")]);
  });
});
