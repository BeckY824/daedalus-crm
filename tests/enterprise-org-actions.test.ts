/**
 * 企业版「组织架构」设置页的写操作（settings/org-actions.ts）。
 * 钉的是：不是企业版 / 共享区 / 普通人一律拦、一行不写；总管理员能改但动不了总管级角色；
 * 部门层数、成环的上级、接口直调塞进来的别的字段都挡住；写成了留一条操作记录。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "老板", email: "a@x", role: "ADMIN", title: "", avatar: null },
  企业版: true,
  共享区: false,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));
vi.mock("@/lib/enterprise/switch", () => ({ 企业版: () => mocks.企业版 }));
vi.mock("@/lib/shared-ws/current", () => ({ 当前是共享区: async () => mocks.共享区 }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 建部门, 改部门, 删部门, 设成员 } from "@/app/(app)/settings/org-actions";

let 老板: string;
let 总管: string;
let 销售: string;
let 主管: string;

const 记录 = () => prisma.auditLog.findMany({ orderBy: { at: "asc" }, select: { entity: true, summary: true } });
const 部门id = async (name: string) => (await prisma.entDept.findFirstOrThrow({ where: { name } })).id;
const 当 = (id: string, role = "SALES") => { mocks.user = { ...mocks.user, id, role }; };

beforeEach(async () => {
  await resetDb();
  mocks.企业版 = true;
  mocks.共享区 = false;
  const 建人 = async (email: string, name: string, role: string) => (await prisma.user.create({ data: { email, name, title: "", role, password: "x" } })).id;
  老板 = await 建人("boss", "老板", "ADMIN");
  总管 = await 建人("dir", "总管", "SALES");
  销售 = await 建人("s1", "小王", "SALES");
  主管 = await 建人("m1", "老李", "MANAGER");
  await prisma.entMember.create({ data: { userId: 总管, bizRole: "director" } });
  当(老板, "ADMIN");
});

describe("谁能改", () => {
  it("不是企业版、共享区、普通销售都拦，一行不写", async () => {
    for (const 设 of [() => { mocks.企业版 = false; }, () => { mocks.共享区 = true; }, () => 当(销售)]) {
      mocks.企业版 = true; mocks.共享区 = false; 当(老板, "ADMIN");
      设();
      expect(await 建部门("内贸部", null)).toMatchObject({ ok: false, error: expect.stringContaining("只有老板或总管理员") });
      expect(await 设成员(销售, { line: "内贸" })).toMatchObject({ ok: false });
    }
    expect(await prisma.entDept.count()).toBe(0);
    expect(await prisma.entMember.count()).toBe(1);
    expect(await 记录()).toEqual([]);
  });

  it("总管理员能建部门、给人定部门，但动不了总管级角色", async () => {
    当(总管);
    expect(await 建部门("内贸部", null)).toEqual({ ok: true });
    expect(await 设成员(销售, { deptId: await 部门id("内贸部") })).toEqual({ ok: true });
    expect(await 设成员(销售, { bizRole: "admin" })).toMatchObject({ ok: false, error: expect.stringContaining("只有老板") });
    expect(await 设成员(总管, { bizRole: "sales" })).toMatchObject({ ok: false, error: expect.stringContaining("只有老板") });
    当(老板, "ADMIN");
    expect(await 设成员(销售, { bizRole: "admin" })).toEqual({ ok: true });
  });
});

describe("部门", () => {
  it("建、改名、挪动、删；最多 3 层，不能挪到自己底下，同级不重名", async () => {
    expect(await 建部门("内贸部", null)).toEqual({ ok: true });
    expect(await 建部门("内贸部", null)).toMatchObject({ ok: false, error: "同一级已经有这个部门了" });
    const 内贸 = await 部门id("内贸部");
    expect(await 建部门("一组", 内贸)).toEqual({ ok: true });
    const 一组 = await 部门id("一组");
    expect(await 建部门("一班", 一组)).toEqual({ ok: true });
    expect(await 建部门("一小队", await 部门id("一班"))).toMatchObject({ ok: false, error: "部门最多 3 层" });
    expect(await 改部门(内贸, { name: "内贸部", parentId: 一组 })).toMatchObject({ ok: false, error: "不能挪到自己或自己的下级部门底下" });
    expect(await 改部门(一组, { name: "华东组", parentId: null })).toEqual({ ok: true });
    expect(await 删部门(一组)).toMatchObject({ ok: false, error: "先删掉或挪走它下面的部门" });
    await 设成员(销售, { deptId: 内贸 });
    expect(await 删部门(内贸)).toMatchObject({ ok: false, error: expect.stringContaining("还有 1 个人") });
    await 设成员(销售, { deptId: null });
    expect(await 删部门(内贸)).toEqual({ ok: true });
    expect((await 记录()).map((x) => x.summary)).toEqual([
      "新建部门「内贸部」", "新建部门「一组」", "新建部门「一班」",
      "部门「一组」改名为「华东组」，挪到「最上层」底下",
      "组织架构：小王 部门 → 内贸部", "组织架构：小王 部门 → 未分部门", "删除部门「内贸部」",
    ]);
  });
});

describe("成员", () => {
  it("上级不能是自己、不能是自己的下属；虚线单独查", async () => {
    expect(await 设成员(销售, { managerId: 销售 })).toMatchObject({ ok: false, error: "上级不能是自己" });
    expect(await 设成员(销售, { managerId: 主管 })).toEqual({ ok: true });
    expect(await 设成员(主管, { managerId: 销售 })).toMatchObject({ ok: false, error: expect.stringContaining("下属") });
    // 实线下属可以当虚线上级（两条链分开算）
    expect(await 设成员(主管, { dottedManagerId: 销售 })).toEqual({ ok: true });
    expect(await 设成员(销售, { dottedManagerId: 主管 })).toMatchObject({ ok: false, error: expect.stringContaining("虚线下属") });
  });

  it("接口直调：只认白名单字段；角色、业务线乱填拦", async () => {
    expect(await 设成员(销售, { line: "内贸", userId: 老板, bizRole: undefined } as never)).toEqual({ ok: true });
    expect(await prisma.entMember.findUniqueOrThrow({ where: { userId: 销售 } })).toMatchObject({ userId: 销售, line: "内贸", bizRole: "sales" });
    expect(await 设成员(销售, { bizRole: "god" })).toMatchObject({ ok: false, error: "没有这个角色" });
    expect(await 设成员(销售, { line: "海外" })).toMatchObject({ ok: false });
    expect(await 设成员(销售, {})).toEqual({ ok: true });
    expect((await 记录()).map((x) => x.summary)).toEqual(["组织架构：小王 业务线 → 内贸"]);
  });

  it("停用的人改不了", async () => {
    await prisma.user.update({ where: { id: 销售 }, data: { active: false } });
    expect(await 设成员(销售, { line: "外贸" })).toMatchObject({ ok: false, error: "这个人不在职" });
  });
});
