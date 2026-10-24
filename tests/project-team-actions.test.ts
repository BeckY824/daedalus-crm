/**
 * 项目详情的编辑项目、项目组，设置里的两个上级（projects/actions.ts）。
 * 钉的是：开关关着一律拦、一行不写；写成了留一条操作记录；没改动不留记录。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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
import { 编辑项目, 加项目组员, 换项目组员角色, 移出项目组员 } from "@/app/(app)/projects/actions";
import { 角色字典 } from "@/lib/project/db";

let 甲: string;
let 乙: string;
let 项目id: string;

const 记录 = () => prisma.auditLog.findMany({ orderBy: { at: "asc" }, select: { entity: true, entityId: true, summary: true } });

beforeEach(async () => {
  await resetDb();
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
