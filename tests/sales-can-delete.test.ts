/**
 * 老板可以关掉「业务员删客户」（2026-10-26，0.46.28，业务配置 salesCanDelete）。
 * 默认能删；关掉以后团队里的业务员删不了（预检和真删都挡），老板 / 单人版照删。
 */
import { it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
  业务员: false,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));
// 「团队里的业务员」看的是 .team.json：这里直接切
vi.mock("@/lib/team-scope", async (orig) => ({
  ...(await orig<typeof import("@/lib/team-scope")>()),
  限定的我: async () => (mocks.业务员 ? mocks.user.id : null),
}));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { deleteCustomers, 客户删除预检 } from "@/app/(app)/customers/actions";
import { getBusiness, saveBusiness } from "@/lib/business";

let id = "";
beforeEach(async () => {
  await resetDb();
  mocks.业务员 = false;
  const u = await prisma.user.create({ data: { email: "a@x", name: "甲", title: "销售", role: "SALES", password: "x" } });
  mocks.user.id = u.id;
  id = (await prisma.customer.create({ data: { name: "要删的", phone: "13800000001", salesOwnerId: u.id } })).id;
});
afterAll(async () => { await prisma.$disconnect(); });

it("默认业务员能删", async () => {
  mocks.业务员 = true;
  expect((await getBusiness()).salesCanDelete).toBe(true);
  expect(await 客户删除预检([id])).toEqual({ ok: true });
  expect(await deleteCustomers([id])).toMatchObject({ ok: true, deleted: 1 });
});

it("老板关掉以后：业务员预检和真删都挡，客户还在", async () => {
  await saveBusiness({ ...(await getBusiness()), salesCanDelete: false });
  mocks.业务员 = true;
  const 预 = await 客户删除预检([id]);
  expect(预).toMatchObject({ ok: false });
  expect((预 as { error: string }).error).toContain("退回公海");
  expect(await deleteCustomers([id])).toMatchObject({ ok: false });
  expect(await prisma.customer.count({ where: { id } })).toBe(1);
});

it("关掉了老板自己照删（不是受限的业务员）", async () => {
  await saveBusiness({ ...(await getBusiness()), salesCanDelete: false });
  expect(await 客户删除预检([id])).toEqual({ ok: true });
  expect(await deleteCustomers([id])).toMatchObject({ ok: true, deleted: 1 });
});
