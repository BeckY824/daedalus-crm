import { beforeEach, afterAll, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: { id: "", name: "QA-admin", email: "qa-admin", role: "ADMIN", title: "管理员" } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async (original) => ({ ...(await original<object>()), requireUser: async () => state.user }));
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { saveUser, reactivateUser } from "@/app/(app)/settings/actions";
let memberId: string;
beforeEach(async () => {
  await resetDb();
  state.user.id = (await prisma.user.create({ data: { name: "QA-admin", email: "qa-admin", password: "unused", role: "ADMIN" } })).id;
  memberId = (await prisma.user.create({ data: { name: "QA-member", email: "qa-member", password: "original", role: "SALES" } })).id;
});
afterAll(async () => { await prisma.$disconnect(); });
it("T-038 编辑成员占用已有登录名：明确拒绝，身份/密码及审计不改变", async () => {
  const before = await prisma.user.findUniqueOrThrow({ where: { id: memberId } });
  await expect(saveUser({ id: memberId, name: "QA-改名", email: " QA-ADMIN ", title: "经理", role: "SALES", active: true, password: "newpass123" })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("占用") });
  expect(await prisma.user.findUniqueOrThrow({ where: { id: memberId } })).toEqual(before);
  expect(await prisma.auditLog.count()).toBe(0);
});
it("T-038 修改为未占用登录名可保存", async () => {
  expect((await saveUser({ id: memberId, name: "QA-member", email: "qa-new", title: "销售", role: "SALES", active: true })).ok).toBe(true);
  expect((await prisma.user.findUniqueOrThrow({ where: { id: memberId } })).email).toBe("qa-new");
});
it.each([null, {}, { email: 5 }, { name: "", email: "qa-new", role: "SALES", active: true, title: "" }])("成员非法参数返回可见错误且不写库：%j", async (input) => {
  await expect(saveUser(input as unknown as Parameters<typeof saveUser>[0])).resolves.toMatchObject({ ok: false, error: expect.any(String) });
  expect(await prisma.user.count()).toBe(2);
  expect(await prisma.auditLog.count()).toBe(0);
});
it("T-039 恢复不存在的成员返回错误", async () => {
  await expect(reactivateUser("qa-missing")).resolves.toMatchObject({ ok: false, error: expect.any(String) });
  expect(await prisma.auditLog.count()).toBe(0);
});
it("T-039 重复恢复已在职成员不重复写审计", async () => {
  expect((await reactivateUser(memberId)).ok).toBe(true);
  expect((await reactivateUser(memberId)).ok).toBe(true);
  expect(await prisma.auditLog.count()).toBe(0);
});
