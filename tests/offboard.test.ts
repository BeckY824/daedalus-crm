/**
 * 离职交接（企业版 D-36，2026-10-24）：停用成员时一次处理完他名下全部，两种方式——
 *   转交 —— 全给接手人（原来的做法），他负责、挂在别人客户上的没结局项目也一起转
 *   公海 —— 客户进客户公海、线索 / 商机阶段项目回项目公海；已签约 / 已流失、名下有订单阶段项目的客户和订单阶段项目给接手人
 * 停用前的清点和停用本身同一套分法，数要对得上；200 条以内一次做完不卡
 * 不是企业版（CRM_ENTERPRISE 不设）：没有公海方式、不清点，转交和原来一样（别处的项目不动）
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => mocks.user }));
vi.mock("@/lib/business", async (原) => {
  const m = await 原<typeof import("@/lib/business")>();
  return { ...m, getBusiness: async () => ({ ...(await m.getBusiness()), projectMode: true }) };
});

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { deactivateUser, 停用清点 } from "@/app/(app)/settings/actions";
import { 领取 } from "@/app/(app)/customers/pool-actions";
import { 停用进公海理由, 停用项目进公海理由 } from "@/lib/offboard-db";

let 甲: string;
let 乙: string;
let 丙: string;
let 号 = 0;

const 客户 = (name: string, salesOwnerId: string, followStatus = "跟进中") =>
  prisma.customer.create({ data: { name, phone: `1380000${String(++号).padStart(4, "0")}`, salesOwnerId, followStatus } });
const 项目 = (name: string, ownerId: string, customerId: string, phase = "线索", node = "潜客培育") =>
  prisma.project.create({ data: { name, customerId, ownerId, creatorId: ownerId, phase, node } });
const 项目of = (id: string) => prisma.project.findUniqueOrThrow({ where: { id } });
const 客户of = (id: string) => prisma.customer.findUniqueOrThrow({ where: { id }, include: { pool: true } });

beforeEach(async () => {
  await resetDb();
  号 = 0;
  甲 = (await prisma.user.create({ data: { email: "jia", name: "甲", title: "", role: "ADMIN", password: "x" } })).id;
  乙 = (await prisma.user.create({ data: { email: "yi", name: "乙", title: "", role: "SALES", password: "x" } })).id;
  丙 = (await prisma.user.create({ data: { email: "bing", name: "丙", title: "", role: "SALES", password: "x" } })).id;
  mocks.user = { ...mocks.user, id: 甲, role: "ADMIN" };
  vi.stubEnv("CRM_ENTERPRISE", "1");
});
afterEach(() => { vi.unstubAllEnvs(); });

afterAll(async () => { await prisma.$disconnect(); });

describe("不是企业版", () => {
  beforeEach(() => { vi.stubEnv("CRM_ENTERPRISE", ""); });

  it("放进公海方式直接拒，什么都不动；清点也不给", async () => {
    const c = await 客户("乙的客户", 乙);
    const p = await 项目("乙的", 乙, c.id);
    expect(await deactivateUser(乙, 丙, "公海")).toMatchObject({ ok: false, error: expect.stringContaining("企业版") });
    expect((await 客户of(c.id))).toMatchObject({ salesOwnerId: 乙, pool: null });
    expect((await 项目of(p.id)).ownerId).toBe(乙);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: 乙 } })).active).toBe(true);
    expect(await 停用清点(乙)).toMatchObject({ ok: false, error: expect.stringContaining("企业版") });
  });

  it("转交和原来一样：项目只跟着转走的客户走，他挂在别人客户上的项目留着", async () => {
    const c = await 客户("乙的客户", 乙);
    const 丙的客户 = await 客户("丙的客户", 丙);
    const p1 = await 项目("乙的", 乙, c.id);
    const p2 = await 项目("别处的", 乙, 丙的客户.id);
    expect(await deactivateUser(乙, 甲)).toEqual({ ok: true });
    expect((await 客户of(c.id)).salesOwnerId).toBe(甲);
    expect((await 项目of(p1.id)).ownerId).toBe(甲);
    expect((await 项目of(p2.id)).ownerId).toBe(乙);
    expect(await prisma.customerPool.count()).toBe(0);
  });
});

describe("转交（默认）", () => {
  it("客户、活、项目全给接手人；他挂在别人客户上的没结局项目也转，有结局的留着；跟进和建档人照旧", async () => {
    const c = await 客户("乙的客户", 乙);
    const 丙的客户 = await 客户("丙的客户", 丙);
    const 跟进 = await prisma.followUp.create({ data: { type: "PHONE", title: "打过电话", content: "聊了", customerId: c.id, ownerId: 乙 } });
    const 待办 = await prisma.task.create({ data: { title: "回电", customerId: c.id, ownerId: 乙 } });
    const 计划 = await prisma.followPlan.create({ data: { subject: "下周见", plannedAt: new Date(), customerId: 丙的客户.id, ownerId: 乙 } });
    const 商机 = await prisma.opportunity.create({ data: { name: "一单", customerId: 丙的客户.id, ownerId: 乙 } });
    const 赢了的 = await prisma.opportunity.create({ data: { name: "赢了", customerId: c.id, ownerId: 乙, status: "WON", stage: "赢单成交" } });
    const p1 = await 项目("乙的", 乙, c.id);
    const p2 = await 项目("别处的", 乙, 丙的客户.id, "订单", "签约");
    const p3 = await prisma.project.update({ where: { id: (await 项目("收尾的", 乙, 丙的客户.id)).id }, data: { result: "成功交付" } });

    expect(await deactivateUser(乙, 丙)).toEqual({ ok: true });

    expect((await 客户of(c.id)).salesOwnerId).toBe(丙);
    expect((await 客户of(c.id)).pool).toBeNull();
    expect((await prisma.task.findUniqueOrThrow({ where: { id: 待办.id } })).ownerId).toBe(丙);
    expect((await prisma.followPlan.findUniqueOrThrow({ where: { id: 计划.id } })).ownerId).toBe(丙);
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: 商机.id } })).ownerId).toBe(丙);
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: 赢了的.id } })).ownerId).toBe(乙);
    expect((await 项目of(p1.id)).ownerId).toBe(丙);
    expect((await 项目of(p2.id)).ownerId).toBe(丙);
    expect((await 项目of(p3.id)).ownerId).toBe(乙);
    // 历史：写过的跟进、建的项目照旧显示是他；转让痕记下从他到接手人、谁操作的
    expect((await prisma.followUp.findUniqueOrThrow({ where: { id: 跟进.id } })).ownerId).toBe(乙);
    expect((await 项目of(p1.id)).creatorId).toBe(乙);
    const 痕 = await prisma.projectNodeLog.findMany({ where: { kind: "transfer" }, select: { projectId: true, userId: true, fromOwnerId: true, toOwnerId: true } });
    expect(new Set(痕.map((x) => x.projectId))).toEqual(new Set([p1.id, p2.id]));
    expect(痕.every((x) => x.userId === 甲 && x.fromOwnerId === 乙 && x.toOwnerId === 丙)).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: 乙 } })).active).toBe(false);
  });

  it("交接方式传错了直接拒，什么都不动", async () => {
    const c = await 客户("乙的客户", 乙);
    expect(await deactivateUser(乙, 丙, "随便" as never)).toMatchObject({ ok: false });
    expect((await 客户of(c.id)).salesOwnerId).toBe(乙);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: 乙 } })).active).toBe(true);
  });
});

describe("放进公海", () => {
  it("一般客户进客户公海（负责人先不改、写明原因）；已签约 / 已流失、有订单阶段项目的给接手人", async () => {
    const 跟进中 = await 客户("跟进中", 乙);
    const 签约 = await 客户("签约", 乙, "已签约");
    const 流失 = await 客户("流失", 乙, "已流失");
    const 有订单 = await 客户("有订单", 乙);
    const 订单项目 = await 项目("订单的", 丙, 有订单.id, "订单", "签约");
    const 本来在公海 = await 客户("本来在公海", 乙);
    await prisma.customerPool.create({ data: { customerId: 本来在公海.id, userId: 乙, reason: "手动" } });

    expect(await deactivateUser(乙, 丙, "公海")).toEqual({ ok: true });

    const 公海里 = await 客户of(跟进中.id);
    expect(公海里.salesOwnerId).toBe(乙);
    expect(公海里.pool).toMatchObject({ reason: 停用进公海理由, userId: 甲 });
    expect((await 客户of(本来在公海.id)).pool).toMatchObject({ reason: "手动" });
    for (const c of [签约, 流失, 有订单]) {
      const r = await 客户of(c.id);
      expect([r.name, r.salesOwnerId, r.pool]).toEqual([c.name, 丙, null]);
    }
    expect((await 项目of(订单项目.id)).ownerId).toBe(丙);
  });

  it("项目：线索 / 商机阶段的回项目公海（留放回痕），订单阶段的只能给接手人，有结局的留着", async () => {
    const 丙的客户 = await 客户("丙的客户", 丙);
    const 线索 = await 项目("线索的", 乙, 丙的客户.id);
    const 商机 = await 项目("商机的", 乙, 丙的客户.id, "商机", "方案报价");
    const 订单 = await 项目("订单的", 乙, 丙的客户.id, "订单", "签约");
    const 收尾 = await prisma.project.update({ where: { id: (await 项目("收尾的", 乙, 丙的客户.id)).id }, data: { result: "成功交付" } });

    expect(await deactivateUser(乙, 甲, "公海")).toEqual({ ok: true });

    for (const p of [线索, 商机]) {
      const r = await 项目of(p.id);
      expect(r.pooledAt).not.toBeNull();
      expect(r.ownerId).toBe(乙);
    }
    const 放回 = await prisma.projectNodeLog.findMany({ where: { kind: "pool-release" }, select: { projectId: true, userId: true, fromOwnerId: true, toOwnerId: true, reason: true } });
    expect(new Set(放回.map((x) => x.projectId))).toEqual(new Set([线索.id, 商机.id]));
    expect(放回.every((x) => x.userId === 甲 && x.fromOwnerId === 乙 && x.toOwnerId === null && x.reason === 停用项目进公海理由)).toBe(true);
    expect(await 项目of(订单.id)).toMatchObject({ ownerId: 甲, pooledAt: null });
    expect(await 项目of(收尾.id)).toMatchObject({ ownerId: 乙, pooledAt: null });
  });

  it("进公海客户上没做完的活留在他名下，有人领了跟着走；别的客户上的活、线索给接手人", async () => {
    const 去公海 = await 客户("去公海", 乙);
    const 丙的客户 = await 客户("丙的客户", 丙);
    const 公海上的待办 = await prisma.task.create({ data: { title: "回电", customerId: 去公海.id, ownerId: 乙 } });
    const 公海上的商机 = await prisma.opportunity.create({ data: { name: "一单", customerId: 去公海.id, ownerId: 乙 } });
    const 别处的计划 = await prisma.followPlan.create({ data: { subject: "下周见", plannedAt: new Date(), customerId: 丙的客户.id, ownerId: 乙 } });
    const 线索 = await prisma.lead.create({ data: { name: "线索", ownerId: 乙 } });

    expect(await deactivateUser(乙, 甲, "公海")).toEqual({ ok: true });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: 公海上的待办.id } })).ownerId).toBe(乙);
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: 公海上的商机.id } })).ownerId).toBe(乙);
    expect((await prisma.followPlan.findUniqueOrThrow({ where: { id: 别处的计划.id } })).ownerId).toBe(甲);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: 线索.id } })).ownerId).toBe(甲);

    // 丙从公海领走：客户、他没做完的活一起归丙
    mocks.user = { ...mocks.user, id: 丙, role: "SALES" };
    expect(await 领取([去公海.id])).toMatchObject({ ok: true, updated: 1 });
    expect(await 客户of(去公海.id)).toMatchObject({ salesOwnerId: 丙, pool: null });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: 公海上的待办.id } })).ownerId).toBe(丙);
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: 公海上的商机.id } })).ownerId).toBe(丙);
  });
});

describe("停用清点", () => {
  it("两种方式的数和真停用时做的对得上", async () => {
    const c1 = await 客户("跟进中", 乙);
    await 客户("签约", 乙, "已签约");
    const 本来在公海 = await 客户("本来在公海", 乙);
    await prisma.customerPool.create({ data: { customerId: 本来在公海.id, userId: 乙 } });
    const 丙的客户 = await 客户("丙的客户", 丙);
    await 项目("跟客户的", 丙, c1.id);
    await 项目("别处线索", 乙, 丙的客户.id);
    await 项目("别处订单", 乙, 丙的客户.id, "订单", "签约");

    const 点 = await 停用清点(乙);
    expect(点).toEqual({
      ok: true,
      转交: { 客户: 3, 进公海客户: 0, 项目: 3, 进公海项目: 0, 订单项目: 0 },
      公海: { 客户: 1, 进公海客户: 2, 项目: 1, 进公海项目: 1, 订单项目: 1 },
    });

    expect(await deactivateUser(乙, 甲, "公海")).toEqual({ ok: true });
    expect(await prisma.customer.count({ where: { salesOwnerId: 甲 } })).toBe(1);
    expect(await prisma.customerPool.count()).toBe(2);
    expect(await prisma.project.count({ where: { ownerId: 甲 } })).toBe(1);
    expect(await prisma.project.count({ where: { pooledAt: { not: null } } })).toBe(1);
  });

  it("业务员不能清点", async () => {
    mocks.user = { ...mocks.user, id: 丙, role: "SALES" };
    await expect(停用清点(乙)).rejects.toThrow();
  });
});

describe("一次 200 条", () => {
  const 造 = async () => {
    const 丙的客户 = await 客户("丙的客户", 丙);
    const 客户们 = Array.from({ length: 200 }, (_, i) => ({ name: `客户${i}`, phone: `1390000${String(i).padStart(4, "0")}`, salesOwnerId: 乙 }));
    await prisma.customer.createMany({ data: 客户们 });
    const ids = (await prisma.customer.findMany({ where: { salesOwnerId: 乙 }, select: { id: true } })).map((c) => c.id);
    await prisma.task.createMany({ data: ids.map((customerId) => ({ title: "回电", customerId, ownerId: 乙 })) });
    await prisma.project.createMany({ data: ids.map((customerId, i) => ({ name: `项目${i}`, customerId, ownerId: 乙, creatorId: 乙 })) });
    await prisma.project.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ name: `别处${i}`, customerId: 丙的客户.id, ownerId: 乙, creatorId: 乙 })) });
  };

  it("转交：200 位客户、400 个项目一次转完，每个项目都留转让痕", async () => {
    await 造();
    const 起 = Date.now();
    expect(await deactivateUser(乙, 甲)).toEqual({ ok: true });
    expect(Date.now() - 起).toBeLessThan(15_000);
    expect(await prisma.customer.count({ where: { salesOwnerId: 乙 } })).toBe(0);
    expect(await prisma.project.count({ where: { ownerId: 甲 } })).toBe(400);
    expect(await prisma.projectNodeLog.count({ where: { kind: "transfer" } })).toBe(400);
  }, 60_000);

  it("公海：200 位客户进公海、200 个别处项目回项目公海", async () => {
    await 造();
    const 起 = Date.now();
    expect(await deactivateUser(乙, 甲, "公海")).toEqual({ ok: true });
    expect(Date.now() - 起).toBeLessThan(15_000);
    expect(await prisma.customerPool.count({ where: { reason: 停用进公海理由 } })).toBe(200);
    expect(await prisma.project.count({ where: { pooledAt: { not: null } } })).toBe(200);
    expect(await prisma.projectNodeLog.count({ where: { kind: "pool-release" } })).toBe(200);
    // 客户在公海里：挂在这些客户上的项目先不动，谁领客户谁整体带走
    expect(await prisma.project.count({ where: { ownerId: 乙, pooledAt: null } })).toBe(200);
  }, 60_000);
});
