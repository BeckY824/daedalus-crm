/**
 * 企业版离职由上级办（D-36）：
 *   - 直属上级能给下属办离职、先清点；隔级、虚线、同级不行（FORBIDDEN）；上级不能停用管理员
 *   - 批量停用：同一个接手人一次办完，200 人一次做完；有一个人办不了就一个都不动；单个失败记下来接着办别人
 *   - 不是企业版：只认管理员，和原来一样；批量停用不给
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "", email: "", role: "ADMIN", title: "", avatar: null as string | null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { deactivateUser, 停用清点, 批量停用 } from "@/app/(app)/settings/actions";

type 人 = { id: string; role: string };
let 老板: 人, 经理: 人, 组长: 人, 虚: 人, 销售: 人, 同事: 人, 管: 人;
let 号 = 0;

async function 建(email: string, role: string): Promise<人> {
  const u = await prisma.user.create({ data: { email, name: email, title: "", role, password: "x" } });
  return { id: u.id, role };
}
const 当 = (p: 人) => { mocks.user = { ...mocks.user, id: p.id, role: p.role, name: p.id }; };
const 客户 = (salesOwnerId: string) =>
  prisma.customer.create({ data: { name: `客户${++号}`, phone: `1380000${String(号).padStart(4, "0")}`, salesOwnerId } });
const 在职 = async (p: 人) => (await prisma.user.findUniqueOrThrow({ where: { id: p.id } })).active;

beforeEach(async () => {
  await resetDb();
  号 = 0;
  老板 = await 建("boss", "ADMIN");
  经理 = await 建("mgr", "MANAGER");
  组长 = await 建("lead", "MANAGER");
  虚 = await 建("dotted", "MANAGER");
  销售 = await 建("sales", "SALES");
  同事 = await 建("peer", "SALES");
  管 = await 建("admin2", "ADMIN");
  await prisma.entMember.createMany({
    data: [
      { userId: 经理.id, bizRole: "sales_mgr" },
      { userId: 组长.id, bizRole: "sales_mgr", managerId: 经理.id },
      { userId: 虚.id, bizRole: "sales_mgr" },
      { userId: 销售.id, managerId: 组长.id, dottedManagerId: 虚.id },
      { userId: 同事.id, managerId: 组长.id },
      { userId: 管.id, managerId: 组长.id },
    ],
  });
  当(老板);
  vi.stubEnv("CRM_ENTERPRISE", "1");
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { await prisma.$disconnect(); });

describe("上级办离职", () => {
  it("直属上级能清点、能停用，转交照常，留痕记的是上级", async () => {
    const c = await 客户(销售.id);
    当(组长);
    expect(await 停用清点(销售.id)).toMatchObject({ ok: true, 转交: { 客户: 1 } });
    expect(await deactivateUser(销售.id, 同事.id, "转交")).toEqual({ ok: true });
    expect(await 在职(销售)).toBe(false);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).salesOwnerId).toBe(同事.id);
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: "deactivate", entityId: 销售.id } })).toMatchObject({ userId: 组长.id });
  });

  it("隔级经理、虚线上级、同级销售：FORBIDDEN，什么都不动", async () => {
    for (const 谁 of [经理, 虚, 同事]) {
      当(谁);
      await expect(deactivateUser(销售.id, 同事.id === 谁.id ? 组长.id : 同事.id)).rejects.toThrow("FORBIDDEN");
      await expect(停用清点(销售.id)).rejects.toThrow("FORBIDDEN");
    }
    expect(await 在职(销售)).toBe(true);
  });

  it("上级不能停用管理员；老板照旧都能办", async () => {
    当(组长);
    await expect(deactivateUser(管.id, 同事.id)).rejects.toThrow("FORBIDDEN");
    当(老板);
    expect(await deactivateUser(管.id, 同事.id)).toEqual({ ok: true });
  });

  it("不是企业版：上级不行，只认管理员", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    当(组长);
    await expect(deactivateUser(销售.id, 同事.id)).rejects.toThrow("FORBIDDEN");
    当(老板);
    expect(await deactivateUser(销售.id, 同事.id)).toEqual({ ok: true });
  });
});

describe("批量停用", () => {
  it("上级一次办完几个下属，名下都转给接手人", async () => {
    const 甲 = await 客户(销售.id);
    const 乙 = await 客户(同事.id);
    当(组长);
    expect(await 批量停用([销售.id, 同事.id], 组长.id, "转交")).toEqual({ ok: true, 停了: 2, 失败: [] });
    expect([await 在职(销售), await 在职(同事)]).toEqual([false, false]);
    const 主 = await prisma.customer.findMany({ where: { id: { in: [甲.id, 乙.id] } }, select: { salesOwnerId: true } });
    expect(主.map((x) => x.salesOwnerId)).toEqual([组长.id, 组长.id]);
  });

  it("里面有一个办不了：FORBIDDEN，一个都不动", async () => {
    当(组长);
    await expect(批量停用([销售.id, 经理.id], 同事.id)).rejects.toThrow("FORBIDDEN");
    expect(await 在职(销售)).toBe(true);
  });

  it("单个失败记下来，接着办别人", async () => {
    expect(await 批量停用([销售.id, "不在了"], 组长.id)).toEqual({
      ok: true, 停了: 1, 失败: [{ id: "不在了", error: "停用没成功，刷新再试" }],
    });
    expect(await 在职(销售)).toBe(false);
  });

  it("没选人、接手人在里面、超过 200 人：拒", async () => {
    expect(await 批量停用([], 组长.id)).toMatchObject({ ok: false, error: "先选要停用的成员" });
    expect(await 批量停用([销售.id, 同事.id], 同事.id)).toMatchObject({ ok: false, error: "接手人不能在要停用的人里" });
    expect(await 批量停用(Array.from({ length: 201 }, (_, i) => `x${i}`), 组长.id)).toMatchObject({ ok: false, error: "一次最多停用 200 人" });
    expect(await 在职(销售)).toBe(true);
  });

  it("200 人一次做完", async () => {
    await prisma.user.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ email: `s${i}`, name: `s${i}`, title: "", role: "SALES", password: "x" })) });
    const 们 = (await prisma.user.findMany({ where: { email: { startsWith: "s" }, role: "SALES", NOT: { email: "sales" } }, select: { id: true } })).map((u) => u.id);
    expect(们).toHaveLength(200);
    expect(await 批量停用(们, 组长.id)).toEqual({ ok: true, 停了: 200, 失败: [] });
    expect(await prisma.user.count({ where: { id: { in: 们 }, active: true } })).toBe(0);
  }, 60_000);

  it("不是企业版：批量停用不给", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    expect(await 批量停用([销售.id], 组长.id)).toMatchObject({ ok: false, error: "批量离职是企业版的功能" });
    当(组长);
    await expect(批量停用([销售.id], 同事.id)).rejects.toThrow("FORBIDDEN");
    expect(await 在职(销售)).toBe(true);
  });
});
