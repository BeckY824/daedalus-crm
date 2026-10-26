/**
 * 企业版「交接中」（2026-10-26，测试清单 D10：转出去的数据，交接完成前接手人看不到）：
 *   - 离职（转交）：成员当场停用，客户、待办留在他名下，接手人列表里一个都没有；接手人确认了才转，转完看得到、有留痕；重复确认回错
 *   - 离职（公海）：进公海的那半当场进，给接手人的那半等确认
 *   - 撤回（发起人 / 管理员）、拒收（接手人）：什么都不转；别人撤不了；了结后再确认回错
 *   - 同一个人的离职交接没了结不能再办；成员恢复启用，没确认的离职交接作废
 *   - 转让：给别人的先不换负责人；重复发起不重复记；确认时只转还归原负责人的，名下的活和换负责人记录一起走
 *   - 两个人同时了结同一笔只成一个；转给自己照旧当场换
 *   - 开关关掉：规则关着、不是企业版，离职 / 转让和原来一样当场转，一行交接都不写；不是企业版确认回错、列表回空
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "", email: "", role: "ADMIN", title: "", avatar: null as string | null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { setSetting } from "@/lib/settings";
import { deactivateUser, reactivateUser } from "@/app/(app)/settings/actions";
import { assignSalesOwner } from "@/app/(app)/customers/actions";
import { 待确认的交接, 确认交接, 撤回交接, 拒收交接 } from "@/app/(app)/customers/handover-actions";
import { 了结 } from "@/lib/enterprise/handover-db";
import { 以谁的身份 } from "@/lib/enterprise/visibility";

type 人 = { id: string; role: string };
let 老板: 人, 组长: 人, 销售: 人, 接手: 人;
let 号 = 0;

async function 建(email: string, role: string): Promise<人> {
  const u = await prisma.user.create({ data: { email, name: email, title: "", role, password: "x" } });
  return { id: u.id, role };
}
const 当 = (p: 人) => { mocks.user = { ...mocks.user, id: p.id, role: p.role, name: p.id }; };
const 客户 = (salesOwnerId: string, followStatus = "待跟进") =>
  prisma.customer.create({ data: { name: `客户${++号}`, phone: `1380000${String(号).padStart(4, "0")}`, salesOwnerId, followStatus } });
const 归谁 = async (id: string) => (await prisma.customer.findUniqueOrThrow({ where: { id } })).salesOwnerId;
const 接手看得到 = () => 以谁的身份(接手.id, () => prisma.customer.findMany({ select: { id: true } }));
const 一笔 = () => prisma.entHandover.findFirstOrThrow();

beforeEach(async () => {
  await resetDb();
  号 = 0;
  老板 = await 建("boss", "ADMIN");
  组长 = await 建("lead", "MANAGER");
  销售 = await 建("sales", "SALES");
  接手 = await 建("taker", "SALES");
  await prisma.entMember.createMany({
    data: [
      { userId: 组长.id, bizRole: "sales_mgr" },
      { userId: 销售.id, managerId: 组长.id },
      { userId: 接手.id, managerId: 组长.id },
    ],
  });
  当(老板);
  vi.stubEnv("CRM_ENTERPRISE", "1");
  await setSetting("enterprise.rule.org_scope", true);
  await setSetting("enterprise.rule.handover_confirm", true);
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { await prisma.$disconnect(); });

describe("离职交接中", () => {
  it("转交：确认前留在原负责人名下、接手人看不到；确认后转过去、看得到、有留痕；重复确认回错", async () => {
    const c = await 客户(销售.id);
    const t = await prisma.task.create({ data: { title: "回电", customerId: c.id, ownerId: 销售.id } });

    expect(await deactivateUser(销售.id, 接手.id, "转交")).toEqual({ ok: true, 交接中: true });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: 销售.id } })).active).toBe(false);
    expect(await 归谁(c.id)).toBe(销售.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).ownerId).toBe(销售.id);
    expect(await 接手看得到()).toEqual([]);
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: "deactivate", entityId: 销售.id } })).toMatchObject({ userId: 老板.id });

    当(接手);
    const 列 = await 待确认的交接();
    expect(列.等我确认).toHaveLength(1);
    expect(列.等我确认[0]).toMatchObject({ kind: "离职", way: "转交", 客户: [c.name], 客户总数: 1, 我能确认: true, 我能撤回: false });
    expect(列.我发起的).toEqual([]);

    expect(await 确认交接(列.等我确认[0].id)).toEqual({ ok: true, 客户: 1 });
    expect(await 归谁(c.id)).toBe(接手.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).ownerId).toBe(接手.id);
    expect((await 接手看得到()).map((x) => x.id)).toEqual([c.id]);
    expect(await 一笔()).toMatchObject({ status: "已确认", doneById: 接手.id });
    expect(await prisma.customerOwnerLog.findFirstOrThrow({ where: { customerId: c.id } })).toMatchObject({ fromOwnerId: 销售.id, toOwnerId: 接手.id, kind: "deactivate", userId: 老板.id });
    expect(await prisma.auditLog.count({ where: { action: "deactivate", entityId: 销售.id } })).toBe(2);

    expect(await 确认交接(列.等我确认[0].id)).toMatchObject({ ok: false });
    expect((await 待确认的交接()).等我确认).toEqual([]);
  });

  it("公海：该进公海的当场进，给接手人的等确认", async () => {
    const 去公海 = await 客户(销售.id);
    const 签了 = await 客户(销售.id, "已签约");
    expect(await deactivateUser(销售.id, 接手.id, "公海")).toEqual({ ok: true, 交接中: true });
    expect((await prisma.customerPool.findMany()).map((p) => p.customerId)).toEqual([去公海.id]);
    expect(await 归谁(签了.id)).toBe(销售.id);
    // 公海里的谁都看得到；给接手人的那位确认前看不到
    expect((await 接手看得到()).map((x) => x.id)).toEqual([去公海.id]);

    当(接手);
    expect(await 确认交接((await 一笔()).id)).toEqual({ ok: true, 客户: 1 });
    expect(await 归谁(签了.id)).toBe(接手.id);
    expect(await 归谁(去公海.id)).toBe(销售.id);
    expect(await prisma.customerPool.count()).toBe(1);
  });

  it("撤回、拒收：什么都不转；别人撤不了；了结之后确认回错", async () => {
    const c = await 客户(销售.id);
    await deactivateUser(销售.id, 接手.id);
    const h = await 一笔();

    当(组长);
    expect(await 撤回交接(h.id)).toEqual({ ok: false, error: "只有发起人或管理员能撤回" });
    当(接手);
    expect(await 撤回交接(h.id)).toMatchObject({ ok: false });
    当(老板);
    expect(await 拒收交接(h.id)).toEqual({ ok: false, error: "只有接手人自己能拒收" });
    expect(await 撤回交接(h.id)).toEqual({ ok: true, 客户: 0 });
    expect(await 一笔()).toMatchObject({ status: "已撤回", doneById: 老板.id });
    当(接手);
    expect(await 确认交接(h.id)).toMatchObject({ ok: false });
    expect(await 归谁(c.id)).toBe(销售.id);

    // 再办一次离职（人已停用，走恢复后重办），这次接手人拒收
    当(老板);
    await reactivateUser(销售.id);
    await deactivateUser(销售.id, 接手.id);
    const h2 = await prisma.entHandover.findFirstOrThrow({ where: { status: "待确认" } });
    当(接手);
    expect(await 拒收交接(h2.id)).toEqual({ ok: true, 客户: 0 });
    expect((await prisma.entHandover.findUniqueOrThrow({ where: { id: h2.id } })).status).toBe("已拒收");
    expect(await 归谁(c.id)).toBe(销售.id);
    expect(await prisma.auditLog.count({ where: { summary: { contains: "数据留在原负责人名下" } } })).toBe(2);
  });

  it("没了结不能再办；恢复启用把没确认的离职交接作废", async () => {
    await 客户(销售.id);
    await deactivateUser(销售.id, 接手.id);
    // 人已停用，再办一次走不到交接；这里直接看守卫：恢复前再发起会被挡
    await prisma.user.update({ where: { id: 销售.id }, data: { active: true } });
    expect(await deactivateUser(销售.id, 组长.id)).toMatchObject({ ok: false, error: expect.stringContaining("还在等接手人确认") });
    await prisma.user.update({ where: { id: 销售.id }, data: { active: false } });

    expect(await reactivateUser(销售.id)).toMatchObject({ ok: true });
    expect(await 一笔()).toMatchObject({ status: "已撤回", doneById: 老板.id });
    当(接手);
    expect(await 确认交接((await 一笔()).id)).toMatchObject({ ok: false });
  });
});

describe("转让交接中", () => {
  it("给别人先不换；重复发起不重复记；确认时只转还归原负责人的，活和换负责人记录一起走", async () => {
    const a = await 客户(销售.id);
    const b = await 客户(销售.id);
    const t = await prisma.task.create({ data: { title: "回电", customerId: a.id, ownerId: 销售.id } });

    expect(await assignSalesOwner([a.id, b.id], 接手.id)).toMatchObject({ ok: true, updated: 0, 交接中: 2, 交接已在路上: 0 });
    expect([await 归谁(a.id), await 归谁(b.id)]).toEqual([销售.id, 销售.id]);
    expect(await 接手看得到()).toEqual([]);
    expect(await assignSalesOwner([a.id, b.id], 接手.id)).toMatchObject({ ok: true, 交接中: 0, 交接已在路上: 2 });
    expect(await prisma.entHandover.count()).toBe(1);

    当(老板);
    expect((await 待确认的交接()).我发起的).toHaveLength(1);
    // 交接期间 b 被直接改给了组长（自己转给自己，不走交接）
    当(组长);
    await prisma.customer.update({ where: { id: b.id }, data: { salesOwnerId: 组长.id } });

    当(接手);
    expect(await 确认交接((await 一笔()).id)).toEqual({ ok: true, 客户: 1 });
    expect(await 归谁(a.id)).toBe(接手.id);
    expect(await 归谁(b.id)).toBe(组长.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).ownerId).toBe(接手.id);
    expect(await prisma.customerOwnerLog.findFirstOrThrow({ where: { customerId: a.id } })).toMatchObject({ fromOwnerId: 销售.id, toOwnerId: 接手.id, kind: "assign" });
    expect(await prisma.customerOwnerLog.count({ where: { customerId: b.id } })).toBe(0);
  });

  it("多位原负责人：一人一笔", async () => {
    const a = await 客户(销售.id);
    const b = await 客户(组长.id);
    expect(await assignSalesOwner([a.id, b.id], 接手.id)).toMatchObject({ ok: true, 交接中: 2 });
    expect(await prisma.entHandover.count()).toBe(2);
  });

  it("转给自己：当场换", async () => {
    const a = await 客户(销售.id);
    当(组长);
    expect(await assignSalesOwner([a.id], 组长.id)).toMatchObject({ ok: true, updated: 1 });
    expect(await 归谁(a.id)).toBe(组长.id);
    expect(await prisma.entHandover.count()).toBe(0);
  });

  it("两个人同时了结同一笔：只成一个", async () => {
    await 客户(销售.id);
    await assignSalesOwner([(await prisma.customer.findFirstOrThrow()).id], 接手.id);
    const h = await 一笔();
    const 成 = await Promise.all([了结(prisma, h.id, "已确认", 接手.id), 了结(prisma, h.id, "已撤回", 老板.id)]);
    expect(成.filter(Boolean)).toHaveLength(1);
  });
});

describe("开关关掉", () => {
  for (const 情形 of ["规则关着", "不是企业版"] as const) {
    it(`${情形}：离职、转让当场转，一行交接都不写`, async () => {
      if (情形 === "规则关着") await setSetting("enterprise.rule.handover_confirm", false);
      else vi.stubEnv("CRM_ENTERPRISE", "");
      const a = await 客户(销售.id);
      const b = await 客户(组长.id);

      expect(await deactivateUser(销售.id, 接手.id)).toEqual({ ok: true });
      expect(await 归谁(a.id)).toBe(接手.id);
      expect(await assignSalesOwner([b.id], 接手.id)).toMatchObject({ ok: true, updated: 1 });
      expect(await 归谁(b.id)).toBe(接手.id);
      expect(await prisma.entHandover.count()).toBe(0);

      if (情形 === "不是企业版") {
        当(接手);
        expect(await 待确认的交接()).toEqual({ 等我确认: [], 我发起的: [] });
        // 库里有一行（比如企业版时留下的）也不认
        const h = await prisma.entHandover.create({ data: { kind: "转让", fromUserId: 组长.id, toUserId: 接手.id, byUserId: 老板.id, customerIds: "[]", counts: "{}" } });
        expect(await 确认交接(h.id)).toMatchObject({ ok: false });
        expect(await 撤回交接(h.id)).toMatchObject({ ok: false });
      }
    });
  }
});
