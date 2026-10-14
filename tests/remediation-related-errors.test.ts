import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ user: { id: "", name: "验收", email: "related@qa.local", role: "ADMIN", title: "管理员", avatar: null } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => state.user }));

import { prisma } from "@/lib/prisma";
import { 不在了 } from "@/lib/not-there";
import { saveContact, savePlan, saveTask, toggleTask } from "@/app/(app)/customers/[id]/actions";
import { resetDb } from "./reset";

beforeEach(async () => {
  await resetDb();
  const user = await prisma.user.create({ data: { email: state.user.email, name: state.user.name, password: "qa", role: "ADMIN" } });
  state.user.id = user.id;
});
afterAll(async () => { await prisma.$disconnect(); });

describe("J-098 真实外键失败与记录消失分别说明", () => {
  it.each([
    ["联系人", () => saveContact({ customerId: "deleted-customer", name: "验收联系人", isPrimary: true })],
    ["待办", () => saveTask({ customerId: "deleted-customer", title: "验收待办" })],
    ["计划", () => savePlan({ customerId: "deleted-customer", subject: "验收计划", plannedAt: "2026-11-01", method: "电话" })],
  ] as const)("新建%s时关联客户已消失：不谎称新建记录已删除，不留数据或成功日志", async (_name, save) => {
    const result = await save();
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("关联") });
    if (!result.ok) expect(result.error).not.toContain("这一条已经不在了");
    expect(await prisma.contact.count()).toBe(0);
    expect(await prisma.task.count()).toBe(0);
    expect(await prisma.followPlan.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("被其他数据依赖而禁止删除的真实P2003：记录仍在，提示关联阻止操作", async () => {
    const customer = await prisma.customer.create({ data: { name: "仍在的客户", phone: "13800000123", salesOwnerId: state.user.id } });
    const error = await prisma.user.delete({ where: { id: state.user.id } }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "P2003" });
    const result = 不在了(error);
    expect(result.error).toContain("关联");
    expect(result.error).not.toContain("这一条已经不在了");
    expect(await prisma.user.findUnique({ where: { id: state.user.id } })).not.toBeNull();
    expect(await prisma.customer.findUnique({ where: { id: customer.id } })).not.toBeNull();
  });

  it("真正已删待办的P2025保留已消失提示，不写成功日志", async () => {
    expect(await toggleTask("deleted-task", true)).toMatchObject({ ok: false, error: expect.stringContaining("这一条已经不在了") });
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it.each(["SQLITE_BUSY", "SQLITE_FULL", "SQLITE_IOERR", "P1001"])("未知%s故障继续抛出原错误，不能伪装成关联或删除问题", (code) => {
    const error = Object.assign(new Error("QA storage unavailable"), { code });
    expect(() => 不在了(error)).toThrow(error);
  });
});
