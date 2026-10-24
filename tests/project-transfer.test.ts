/**
 * 项目转让（团队版项目模式 1a，2026-10-23）：
 *   - 手动转一个项目的负责人：只改这一个项目，留一行转让痕（谁、何时、从谁到谁）
 *   - 转客户 = 整体转（总控 10-23 定）：这位客户名下的项目不管原来谁负责、有没有结局都跟着转，只有项目公海里的不动；
 *     撤销各还各的（按转让痕还给转之前的负责人），只还带过来的那几个
 *   - 停用成员：项目跟着转走的客户一起整体转；他负责、挂在别人客户上、没结局的也给接手人（D-36，10-24）
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => mocks.user }));
vi.mock("@/lib/business", async (原) => {
  const m = await 原<typeof import("@/lib/business")>();
  return { ...m, getBusiness: async () => ({ ...(await m.getBusiness()), projectMode: true }) };
});

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 编辑项目 } from "@/app/(app)/projects/actions";
import { assignSalesOwner, 撤销改负责人 } from "@/app/(app)/customers/actions";
import { deactivateUser } from "@/app/(app)/settings/actions";
import { 角色字典 } from "@/lib/project/db";

let 甲: string;
let 乙: string;
let 丙: string;
let 客户: string;

const 项目 = (name: string, ownerId: string, customerId = 客户) =>
  prisma.project.create({ data: { name, customerId, ownerId, creatorId: ownerId } });
const 负责人 = async (id: string) => (await prisma.project.findUniqueOrThrow({ where: { id } })).ownerId;
const 转让痕 = (projectId?: string) =>
  prisma.projectNodeLog.findMany({
    where: { kind: "transfer", ...(projectId ? { projectId } : {}) },
    orderBy: { at: "asc" },
    select: { projectId: true, userId: true, fromOwnerId: true, toOwnerId: true },
  });

beforeEach(async () => {
  await resetDb();
  甲 = (await prisma.user.create({ data: { email: "jia", name: "甲", title: "", role: "ADMIN", password: "x" } })).id;
  乙 = (await prisma.user.create({ data: { email: "yi", name: "乙", title: "", role: "SALES", password: "x" } })).id;
  丙 = (await prisma.user.create({ data: { email: "bing", name: "丙", title: "", role: "SALES", password: "x" } })).id;
  mocks.user = { ...mocks.user, id: 甲, role: "ADMIN" };
  客户 = (await prisma.customer.create({ data: { name: "客户", phone: "13800000001", salesOwnerId: 乙 } })).id;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("手动转一个项目", () => {
  it("只改这个项目的负责人，留一行转让痕：谁转的、从谁到谁；节点不变", async () => {
    const p = await 项目("一期", 乙);
    const 另一个 = await 项目("二期", 乙);
    expect(await 编辑项目(p.id, { name: "一期", ownerId: 丙 })).toEqual({ ok: true });
    expect(await 负责人(p.id)).toBe(丙);
    expect(await 负责人(另一个.id)).toBe(乙);
    expect(await 转让痕()).toEqual([{ projectId: p.id, userId: 甲, fromOwnerId: 乙, toOwnerId: 丙 }]);
    const 痕 = await prisma.projectNodeLog.findFirstOrThrow({ where: { kind: "transfer" } });
    expect([痕.fromPhase, 痕.fromNode, 痕.toPhase, 痕.toNode]).toEqual([p.phase, p.node, p.phase, p.node]);
  });

  it("没换负责人不留转让痕；业务员转不了别人的项目", async () => {
    const p = await 项目("一期", 乙);
    expect(await 编辑项目(p.id, { name: "一期改名", ownerId: 乙 })).toEqual({ ok: true });
    mocks.user = { ...mocks.user, id: 丙, role: "SALES" };
    expect(await 编辑项目(p.id, { name: "一期改名", ownerId: 丙 })).toMatchObject({ ok: false });
    expect(await 负责人(p.id)).toBe(乙);
    expect(await 转让痕()).toEqual([]);
  });
});

describe("转客户", () => {
  it("整体转：这位客户名下的项目不管谁负责、有没有结局都跟着转；别的客户的不动", async () => {
    const 乙的 = await 项目("乙的", 乙);
    const 乙收尾的 = await prisma.project.update({ where: { id: (await 项目("乙收尾的", 乙)).id }, data: { result: "成功交付" } });
    const 丙的 = await 项目("丙的", 丙);
    const 别的客户 = await prisma.customer.create({ data: { name: "别的", phone: "13800000002", salesOwnerId: 乙 } });
    const 乙别处的 = await 项目("乙别处的", 乙, 别的客户.id);

    const r = await assignSalesOwner([客户], 甲);
    if (!r.ok) throw new Error(r.error);
    expect(r.带走).toMatchObject({ 项目: 3 });
    expect(new Set(r.带过来!.项目)).toEqual(new Set([乙的.id, 乙收尾的.id, 丙的.id]));
    expect(await 负责人(乙的.id)).toBe(甲);
    expect(await 负责人(乙收尾的.id)).toBe(甲);
    expect(await 负责人(丙的.id)).toBe(甲);
    expect(await 负责人(乙别处的.id)).toBe(乙);
    const 痕 = await 转让痕();
    expect(痕).toHaveLength(3);
    expect(痕.find((x) => x.projectId === 丙的.id)).toMatchObject({ userId: 甲, fromOwnerId: 丙, toOwnerId: 甲 });
    expect(痕.find((x) => x.projectId === 乙的.id)).toMatchObject({ userId: 甲, fromOwnerId: 乙, toOwnerId: 甲 });
  });

  it("项目公海里的不跟着转，还在公海等人领", async () => {
    const 公海里 = await prisma.project.create({ data: { name: "公海里", customerId: 客户, ownerId: 乙, creatorId: 乙, pooledAt: new Date() } });
    const r = await assignSalesOwner([客户], 丙);
    if (!r.ok) throw new Error(r.error);
    expect(r.带过来!.项目).toEqual([]);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: 公海里.id } })).toMatchObject({ ownerId: 乙 });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: 公海里.id } })).pooledAt).not.toBeNull();
  });

  it("撤销各还各的：按转让痕还给转之前的负责人；新负责人本来就有的留着；撤销也留痕", async () => {
    const 乙的 = await 项目("乙的", 乙);
    const 丙本来的 = await 项目("丙本来的", 丙);
    const 甲的 = await 项目("甲的", 甲);
    const r = await assignSalesOwner([客户], 丙);
    if (!r.ok) throw new Error(r.error);
    expect(new Set(r.带过来!.项目)).toEqual(new Set([乙的.id, 甲的.id]));
    expect(await 撤销改负责人(r.原值!, 丙, r.带过来)).toMatchObject({ ok: true, updated: 1 });
    expect(await 负责人(乙的.id)).toBe(乙);
    expect(await 负责人(甲的.id)).toBe(甲);
    expect(await 负责人(丙本来的.id)).toBe(丙);
    expect(await 转让痕(乙的.id)).toEqual([
      { projectId: 乙的.id, userId: 甲, fromOwnerId: 乙, toOwnerId: 丙 },
      { projectId: 乙的.id, userId: 甲, fromOwnerId: 丙, toOwnerId: 乙 },
    ]);
    expect(await 转让痕(甲的.id)).toEqual([
      { projectId: 甲的.id, userId: 甲, fromOwnerId: 甲, toOwnerId: 丙 },
      { projectId: 甲的.id, userId: 甲, fromOwnerId: 丙, toOwnerId: 甲 },
    ]);
  });

  it("撤销前项目已经被手动转走或放进公海：不还", async () => {
    const 乙的 = await 项目("乙的", 乙);
    const 乙的二 = await 项目("乙的二", 乙);
    const r = await assignSalesOwner([客户], 丙);
    if (!r.ok) throw new Error(r.error);
    await prisma.project.update({ where: { id: 乙的.id }, data: { ownerId: 甲 } });
    await prisma.project.update({ where: { id: 乙的二.id }, data: { pooledAt: new Date() } });
    expect(await 撤销改负责人(r.原值!, 丙, r.带过来)).toMatchObject({ ok: true });
    expect(await 负责人(乙的.id)).toBe(甲);
    expect(await 负责人(乙的二.id)).toBe(丙);
  });

  it("老撤销条没带项目这一项：照样撤，项目不动", async () => {
    const 乙的 = await 项目("乙的", 乙);
    const r = await assignSalesOwner([客户], 丙);
    if (!r.ok) throw new Error(r.error);
    const { 项目: _, ...老的 } = r.带过来!;
    expect(await 撤销改负责人(r.原值!, 丙, 老的)).toMatchObject({ ok: true, updated: 1 });
    expect(await 负责人(乙的.id)).toBe(丙);
  });
});

describe("停用成员", () => {
  it("项目跟着转走的客户整体转（同事负责的也转）；他挂在别人客户上的没结局项目也给接手人，有结局的留着", async () => {
    const 乙的 = await 项目("乙的", 乙);
    const 丙在乙客户上的 = await 项目("丙在乙客户上的", 丙);
    const 丙的客户 = await prisma.customer.create({ data: { name: "丙的客户", phone: "13800000003", salesOwnerId: 丙 } });
    const 乙在丙客户上的 = await 项目("乙在丙客户上的", 乙, 丙的客户.id);
    const 乙收尾的 = await prisma.project.update({ where: { id: (await 项目("乙收尾的", 乙, 丙的客户.id)).id }, data: { result: "成功交付" } });
    expect(await deactivateUser(乙, 甲)).toEqual({ ok: true });
    expect(await 负责人(乙的.id)).toBe(甲);
    expect(await 负责人(丙在乙客户上的.id)).toBe(甲);
    expect(await 负责人(乙在丙客户上的.id)).toBe(甲);
    expect(await 负责人(乙收尾的.id)).toBe(乙);
    expect(new Set((await 转让痕()).map((x) => x.projectId))).toEqual(new Set([乙的.id, 丙在乙客户上的.id, 乙在丙客户上的.id]));
  });
});

it("默认角色 id 固定，各端对得上", async () => {
  expect((await 角色字典()).map((r) => [r.id, r.name])).toEqual([
    ["rd", "产品研发"], ["after-sales", "售后"], ["solution", "商务方案"], ["pm", "项目经理"],
  ]);
});
