/**
 * 企业版两级公海的规则（2026-10-26，lib/enterprise/pool-rules.ts + pool-link.ts）：
 *   - D12：自动掉公海和项目超时回收（Y18）一样，低权限的人先打开页面也按全公司扫；团队模式「今天扫过了」只记在自己号上
 *   - 单项目客户（D6）：名下只有这一个项目，项目进项目公海（放回 / 超时），客户也进客户公海；领项目把客户一起领过来
 *   - 领客户即领项目：领 / 分配客户公海里的客户，名下项目公海里的项目一起过来
 *   - 原负责人不能领回（10-26 定稿「非原负责人均可领取」）：开关在 公海规则，默认拦，报「原负责人不能领回」
 *   - 项目公海从属客户公海：客户进公海名下项目全跟着、谁领谁带走；多项目客户一个项目超期只收这一个
 *   - 超时回收记在「系统」名下（QA #16），不记成打开页面的那位
 *   - 直接指定给某人（批量分配）：新负责人看得到联系人、项目、沟通记录，原负责人看不到了
 *   - 开关关着照旧：上面这些企业版的一条都不做
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "老板", email: "boss@local", role: "ADMIN", title: "", avatar: null as string | null },
  团队: null as null | { teamId: string; key: string; device: string },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));
vi.mock("@/lib/sync/client", () => ({ 读团队: () => mocks.团队 }));
vi.mock("@/lib/llm", () => ({ llmEnabled: async () => false }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { setSetting, invalidateSettingsCache } from "@/lib/settings";
import { 以谁的身份, 忘掉企业版范围 } from "@/lib/enterprise/visibility";
import { 规则 } from "@/lib/enterprise/rules";
import { 公海规则, 单项目客户进公海理由, 原负责人不能领回提示 } from "@/lib/enterprise/pool-rules";
import { 系统, 超时理由 } from "@/lib/project/timeout";
import { 自动掉公海 } from "@/lib/pool-db";
import { 放回公海, 领取公海项目, 公海超时收回 } from "@/lib/project/db";
import { 默认组织规则 } from "@/lib/project/org-rules";
import { 放进公海, 领取, 分配公海 } from "@/app/(app)/customers/pool-actions";
import { assignSalesOwner } from "@/app/(app)/customers/actions";

type 人 = { id: string; name: string; role: string };
let 老板: 人;
let 经理: 人;
let 乙: 人;
let 丙: 人;

async function 造人(email: string, name: string, role: string): Promise<人> {
  const u = await prisma.user.create({ data: { email, name, title: "", role, password: "x" } });
  return { id: u.id, name: u.name, role };
}
let 序 = 0;
async function 客户(ownerId: string, 补: Record<string, unknown> = {}) {
  序++;
  return (await prisma.customer.create({ data: { name: `客户${序}`, phone: `1390000${String(序).padStart(4, "0")}`, salesOwnerId: ownerId, ...补 } })).id;
}
async function 项目(ownerId: string, customerId: string, 补: Record<string, unknown> = {}) {
  return (await prisma.project.create({ data: { name: `项目${++序}`, customerId, ownerId, creatorId: ownerId, ...补 } })).id;
}
const 在客户公海 = async (id: string) => !!(await prisma.customerPool.findUnique({ where: { customerId: id } }));
const 负责人 = async (id: string) => (await prisma.customer.findUniqueOrThrow({ where: { id } })).salesOwnerId;
const 项目在公海 = async (id: string) => (await prisma.project.findUniqueOrThrow({ where: { id } })).pooledAt !== null;
const 当 = (u: 人) => { mocks.user = { ...mocks.user, id: u.id, name: u.name, role: u.role }; };
const 天前 = (n: number, 今: Date) => new Date(今.getTime() - n * 86400_000);
const 今 = new Date("2026-10-26T10:00:00+08:00");

/** 按组织看客户开着：经理管乙、丙；乙、丙互相看不到 */
async function 开按组织看() {
  await setSetting(规则.按组织看客户.key, true);
  await prisma.entMember.createMany({ data: [{ userId: 经理.id, bizRole: "sales_mgr" }, { userId: 乙.id, managerId: 经理.id }, { userId: 丙.id, managerId: 经理.id }] });
  invalidateSettingsCache();
  忘掉企业版范围();
}

const 原规则 = { ...公海规则 };
beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  忘掉企业版范围();
  Object.assign(公海规则, 原规则);
  vi.stubEnv("CRM_ENTERPRISE", "1");
  mocks.团队 = null;
  老板 = await 造人("boss", "老板", "ADMIN");
  经理 = await 造人("mkt", "经理", "MANAGER");
  乙 = await 造人("yi", "乙", "SALES");
  丙 = await 造人("bing", "丙", "SALES");
  当(老板);
  await setSetting("business", { projectMode: true, poolDays: 30 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  忘掉企业版范围();
  Object.assign(公海规则, 原规则);
});

describe("D12 自动掉公海：低权限的人先打开也按全公司扫", () => {
  it("按组织看客户开着，乙带着自己的身份先打开：丙名下 30 天没跟进的也掉；同一天经理再打开不重复扫", async () => {
    await 开按组织看();
    const 乙的 = await 客户(乙.id, { lastFollowAt: 天前(40, 今) });
    const 丙的 = await 客户(丙.id, { lastFollowAt: 天前(40, 今) });
    const 新的 = await 客户(丙.id, { lastFollowAt: 天前(3, 今) });
    // 先确认范围真的生效：乙只看得到自己的
    expect(await 以谁的身份(乙.id, () => prisma.customer.count())).toBe(1);
    expect(await 以谁的身份(乙.id, () => 自动掉公海(乙, 今))).toBe(2);
    expect(await 在客户公海(乙的)).toBe(true);
    expect(await 在客户公海(丙的)).toBe(true);
    expect(await 在客户公海(新的)).toBe(false);
    await 客户(丙.id, { lastFollowAt: 天前(40, 今) });
    expect(await 以谁的身份(经理.id, () => 自动掉公海(经理, 今))).toBe(0);
  });

  it("团队模式每台只扫自己名下的：乙扫过了不挡丙同一天扫自己的", async () => {
    mocks.团队 = { teamId: "t", key: "k", device: "d" };
    const 乙的 = await 客户(乙.id, { lastFollowAt: 天前(40, 今) });
    const 丙的 = await 客户(丙.id, { lastFollowAt: 天前(40, 今) });
    expect(await 自动掉公海(乙, 今)).toBe(1);
    expect(await 在客户公海(丙的)).toBe(false);
    expect(await 自动掉公海(丙, 今)).toBe(1);
    expect(await 在客户公海(乙的)).toBe(true);
    expect(await 在客户公海(丙的)).toBe(true);
    expect(await 自动掉公海(丙, 今)).toBe(0);
  });
});

describe("单项目客户（D6）", () => {
  it("名下只有一个项目，负责人放回项目公海：客户一起进客户公海，理由写清", async () => {
    const c = await 客户(乙.id);
    const p = await 项目(乙.id, c);
    expect(await 放回公海(乙, p)).toEqual({ ok: true });
    expect(await 项目在公海(p)).toBe(true);
    const 行 = await prisma.customerPool.findUniqueOrThrow({ where: { customerId: c } });
    expect(行).toMatchObject({ userId: 乙.id, reason: 单项目客户进公海理由 });
    // 负责人不动，谁领了谁接（同客户公海）
    expect(await 负责人(c)).toBe(乙.id);
  });

  it("名下有两个项目、或客户归别人的：客户不进公海（客户留原负责人，只换项目负责人）", async () => {
    const 两个 = await 客户(乙.id);
    const p1 = await 项目(乙.id, 两个);
    await 项目(乙.id, 两个);
    expect(await 放回公海(乙, p1)).toEqual({ ok: true });
    expect(await 在客户公海(两个)).toBe(false);

    const 别人的 = await 客户(丙.id);
    const p2 = await 项目(乙.id, 别人的);
    expect(await 放回公海(乙, p2)).toEqual({ ok: true });
    expect(await 在客户公海(别人的)).toBe(false);
  });

  it("超时回收进项目公海也一样：单项目客户一起进客户公海（操作人空着，同自动掉公海）", async () => {
    await setSetting("orgRules", { ...默认组织规则, 超时回收: { 开: true, 节点天数: { 潜客培育: 3 } } });
    const c = await 客户(乙.id);
    const p = await 项目(乙.id, c, { createdAt: 天前(10, 今) });
    expect(await 以谁的身份(乙.id, () => 公海超时收回(乙, 今))).toBe(1);
    expect(await 项目在公海(p)).toBe(true);
    expect(await prisma.customerPool.findUniqueOrThrow({ where: { customerId: c } })).toMatchObject({ userId: null, reason: 单项目客户进公海理由 });
    // QA #16：乙打开页面触发的，留痕和操作日志都记「系统」，不记乙
    expect(await prisma.projectNodeLog.findFirstOrThrow({ where: { projectId: p, kind: "pool-release" } })).toMatchObject({ userId: 系统.id, fromOwnerId: 乙.id, reason: 超时理由 });
    expect(await prisma.auditLog.count({ where: { userId: 乙.id } })).toBe(0);
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: "pool", entity: "Project" } })).toMatchObject({ userId: 系统.id, userName: "系统" });
    // 丙领走：客户一起过来，但给乙的收回提醒还留在乙名下
    expect(await 领取公海项目(丙, p)).toEqual({ ok: true });
    expect(await 负责人(c)).toBe(丙.id);
    expect(await prisma.task.count({ where: { customerId: c, ownerId: 乙.id, title: { contains: "已回到项目公海" } } })).toBe(1);
  });

  it("丙领这个项目：客户一起归丙，客户公海那一行删掉、记领取时间，乙在这位客户上没做完的待办跟着过来", async () => {
    const c = await 客户(乙.id);
    const p = await 项目(乙.id, c);
    const 待办 = await prisma.task.create({ data: { title: "回个电话", customerId: c, ownerId: 乙.id } });
    await 放回公海(乙, p);
    expect(await 领取公海项目(丙, p)).toEqual({ ok: true });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p } })).ownerId).toBe(丙.id);
    expect(await 负责人(c)).toBe(丙.id);
    expect(await 在客户公海(c)).toBe(false);
    expect((await prisma.customerClaim.findUniqueOrThrow({ where: { customerId: c } })).userId).toBe(丙.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: 待办.id } })).ownerId).toBe(丙.id);
    expect(await prisma.customerOwnerLog.count({ where: { customerId: c, kind: "claim", toOwnerId: 丙.id } })).toBe(1);
  });

  it("开关（单项目客户跟着进公海 / 领项目带走单项目客户）关了：只动项目", async () => {
    公海规则.单项目客户跟着进公海 = false;
    const c = await 客户(乙.id);
    const p = await 项目(乙.id, c);
    await 放回公海(乙, p);
    expect(await 在客户公海(c)).toBe(false);

    公海规则.单项目客户跟着进公海 = true;
    公海规则.领项目带走单项目客户 = false;
    const c2 = await 客户(乙.id);
    const p2 = await 项目(乙.id, c2);
    await 放回公海(乙, p2);
    expect(await 领取公海项目(丙, p2)).toEqual({ ok: true });
    expect(await 负责人(c2)).toBe(乙.id);
    expect(await 在客户公海(c2)).toBe(true);
  });
});

describe("领客户即领项目", () => {
  it("丙从客户公海领客户：名下放在项目公海里的项目一起归丙，记一行 pool-claim；带走数里算上", async () => {
    const c = await 客户(乙.id);
    const p = await 项目(乙.id, c);
    await 放回公海(乙, p);
    expect(await 在客户公海(c)).toBe(true);
    当(丙);
    const r = await 领取([c]);
    expect(r).toMatchObject({ ok: true, updated: 1 });
    if (r.ok) expect(r.带走?.项目).toBe(1);
    const 现 = await prisma.project.findUniqueOrThrow({ where: { id: p } });
    expect(现).toMatchObject({ ownerId: 丙.id, pooledAt: null });
    expect(await prisma.projectNodeLog.count({ where: { projectId: p, kind: "pool-claim", toOwnerId: 丙.id } })).toBe(1);
  });

  it("老板把公海里的客户分给丙：项目也一起归丙", async () => {
    const c = await 客户(乙.id);
    const p = await 项目(乙.id, c);
    await 放回公海(乙, p);
    当(老板);
    expect(await 分配公海([c], 丙.id)).toMatchObject({ ok: true, updated: 1 });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p } })).ownerId).toBe(丙.id);
    expect(await 项目在公海(p)).toBe(false);
  });

  it("主动退回（业务员把自己的客户放进公海）：没进项目公海的项目跟着客户待着，谁领客户谁整体带走", async () => {
    const c = await 客户(乙.id);
    const p = await 项目(乙.id, c);
    当(乙);
    expect(await 放进公海([c])).toMatchObject({ ok: true, updated: 1 });
    expect(await 项目在公海(p)).toBe(false);
    当(丙);
    expect(await 领取([c])).toMatchObject({ ok: true, updated: 1 });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p } })).ownerId).toBe(丙.id);
  });
});

describe("原负责人不能领回（10-26 定稿）", () => {
  it("默认拦：乙放进公海的客户、放回的项目，乙领都报「原负责人不能领回」，丙照领", async () => {
    expect(公海规则.原负责人能领回).toBe(false);
    const c = await 客户(乙.id);
    const c2 = await 客户(乙.id);
    const p = await 项目(乙.id, c2);
    await prisma.project.create({ data: { name: "另一个", customerId: c2, ownerId: 乙.id, creatorId: 乙.id } });
    当(乙);
    await 放进公海([c]);
    expect(await 领取([c])).toEqual({ ok: false, error: 原负责人不能领回提示 });
    expect(await 在客户公海(c)).toBe(true);
    expect(await 负责人(c)).toBe(乙.id);
    await 放回公海(乙, p);
    expect(await 领取公海项目(乙, p)).toEqual({ ok: false, error: 原负责人不能领回提示 });
    expect(await 项目在公海(p)).toBe(true);
    当(丙);
    expect(await 领取([c])).toMatchObject({ ok: true, updated: 1 });
    expect(await 领取公海项目(丙, p)).toEqual({ ok: true });
  });

  it("超时系统收回的也一样：原负责人乙领不回，丙领得到", async () => {
    await setSetting("orgRules", { ...默认组织规则, 超时回收: { 开: true, 节点天数: { 潜客培育: 3 } } });
    const c = await 客户(乙.id);
    const p = await 项目(乙.id, c, { createdAt: 天前(10, 今) });
    expect(await 公海超时收回(老板, 今)).toBe(1);
    expect(await 领取公海项目(乙, p)).toEqual({ ok: false, error: 原负责人不能领回提示 });
    expect(await 领取公海项目(丙, p)).toEqual({ ok: true });
  });

  it("一次勾了几位，有乙自己的也有别人的：只领别人的，乙自己当原负责人的留在公海", async () => {
    const 自己的 = await 客户(乙.id);
    const 丙的 = await 客户(丙.id);
    当(乙);
    await 放进公海([自己的]);
    当(丙);
    await 放进公海([丙的]);
    当(乙);
    expect(await 领取([自己的, 丙的])).toMatchObject({ ok: true, updated: 1 });
    expect(await 负责人(丙的)).toBe(乙.id);
    expect(await 在客户公海(自己的)).toBe(true);
  });

  it("开关改回能（会上若再改）：原负责人能领回", async () => {
    公海规则.原负责人能领回 = true;
    const c = await 客户(乙.id);
    当(乙);
    await 放进公海([c]);
    expect(await 领取([c])).toMatchObject({ ok: true, updated: 1 });
  });
});

describe("项目公海从属客户公海（10-26 定稿）", () => {
  it("客户进客户公海（主动退回）：名下两个项目都跟着，丙领了客户两个项目都归丙", async () => {
    const c = await 客户(乙.id);
    const p1 = await 项目(乙.id, c);
    const p2 = await 项目(乙.id, c, { phase: "商机", node: "明确需求" });
    当(乙);
    expect(await 放进公海([c])).toMatchObject({ ok: true, updated: 1 });
    当(丙);
    expect(await 领取([c])).toMatchObject({ ok: true, updated: 1 });
    for (const p of [p1, p2]) expect((await prisma.project.findUniqueOrThrow({ where: { id: p } })).ownerId).toBe(丙.id);
    expect(await 负责人(c)).toBe(丙.id);
  });

  it("客户进了公海，其中一个项目先前已进项目公海：领客户时两个都归丙，项目公海里那个也出来", async () => {
    const c = await 客户(乙.id);
    const p1 = await 项目(乙.id, c);
    const p2 = await 项目(乙.id, c);
    await 放回公海(乙, p1);
    expect(await 在客户公海(c)).toBe(false);
    当(乙);
    await 放进公海([c]);
    当(丙);
    expect(await 领取([c])).toMatchObject({ ok: true, updated: 1 });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: p1 } })).toMatchObject({ ownerId: 丙.id, pooledAt: null });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p2 } })).ownerId).toBe(丙.id);
  });

  it("单项目客户的项目超期：客户也进客户公海，丙领项目连客户一起领", async () => {
    await setSetting("orgRules", { ...默认组织规则, 超时回收: { 开: true, 节点天数: { 潜客培育: 3 } } });
    const c = await 客户(乙.id);
    const p = await 项目(乙.id, c, { createdAt: 天前(10, 今) });
    expect(await 公海超时收回(老板, 今)).toBe(1);
    expect(await 在客户公海(c)).toBe(true);
    expect(await 领取公海项目(丙, p)).toEqual({ ok: true });
    expect(await 负责人(c)).toBe(丙.id);
    expect(await 在客户公海(c)).toBe(false);
  });

  it("多项目客户只有一个项目超期：只收这一个项目，客户和另一个项目留在乙名下", async () => {
    await setSetting("orgRules", { ...默认组织规则, 超时回收: { 开: true, 节点天数: { 潜客培育: 3 } } });
    const c = await 客户(乙.id);
    const 超期 = await 项目(乙.id, c, { createdAt: 天前(10, 今) });
    const 新的 = await 项目(乙.id, c, { createdAt: 天前(1, 今) });
    expect(await 公海超时收回(老板, 今)).toBe(1);
    expect(await 项目在公海(超期)).toBe(true);
    expect(await 项目在公海(新的)).toBe(false);
    expect(await 在客户公海(c)).toBe(false);
    expect(await 负责人(c)).toBe(乙.id);
    expect(await 领取公海项目(丙, 超期)).toEqual({ ok: true });
    expect(await 负责人(c)).toBe(乙.id);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: 新的 } })).ownerId).toBe(乙.id);
  });

  it("订单阶段的项目超期也不收", async () => {
    await setSetting("orgRules", { ...默认组织规则, 超时回收: { 开: true, 节点天数: { 潜客培育: 3, 生产备货: 3 } } });
    const c = await 客户(乙.id);
    const p = await 项目(乙.id, c, { createdAt: 天前(60, 今), phase: "订单", node: "生产备货" });
    expect(await 公海超时收回(老板, 今)).toBe(0);
    expect(await 项目在公海(p)).toBe(false);
  });
});

describe("直接指定给某人：联系人、项目、沟通记录跟着客户换人", () => {
  it("老板把乙的客户批量分配给丙：丙带着自己的身份看得到联系人、项目、沟通记录，乙看不到了；沟通记录的记录人不改", async () => {
    await 开按组织看();
    const c = await 客户(乙.id);
    await prisma.contact.create({ data: { name: "张经理", customerId: c } });
    const 跟进 = await prisma.followUp.create({ data: { type: "PHONE", title: "", content: "聊了报价", customerId: c, ownerId: 乙.id, occurredAt: 今 } });
    const p = await 项目(乙.id, c);
    当(老板);
    expect(await assignSalesOwner([c], 丙.id)).toMatchObject({ ok: true, updated: 1 });
    const 看 = (u: 人) => 以谁的身份(u.id, async () => [
      await prisma.customer.count({ where: { id: c } }),
      await prisma.contact.count({ where: { customerId: c } }),
      await prisma.followUp.count({ where: { customerId: c } }),
      await prisma.project.count({ where: { id: p } }),
    ]);
    expect(await 看(丙)).toEqual([1, 1, 1, 1]);
    expect(await 看(乙)).toEqual([0, 0, 0, 0]);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p } })).ownerId).toBe(丙.id);
    expect((await prisma.followUp.findUniqueOrThrow({ where: { id: 跟进.id } })).ownerId).toBe(乙.id);
    // 直接指定给某人不进公海（交接中、确认前看不到由交接那个 PR 管，规则「交接要确认」开着才走）
    expect(await 在客户公海(c)).toBe(false);
  });
});

describe("开关关着照旧", () => {
  beforeEach(() => { vi.stubEnv("CRM_ENTERPRISE", ""); });

  it("单项目客户放回项目公海：客户不跟着进；领项目不带客户；领客户不带项目公海里的项目；放回的人不能自己领回", async () => {
    const c = await 客户(乙.id);
    const p = await 项目(乙.id, c);
    expect(await 放回公海(乙, p)).toEqual({ ok: true });
    expect(await 在客户公海(c)).toBe(false);
    expect(await 领取公海项目(乙, p)).toMatchObject({ ok: false, error: expect.stringContaining("不能自己领回") });

    当(乙);
    await 放进公海([c]);
    当(丙);
    expect(await 领取([c])).toMatchObject({ ok: true, updated: 1 });
    // 项目公海里的项目还在项目公海
    expect(await 项目在公海(p)).toBe(true);
    expect(await 领取公海项目(丙, p)).toEqual({ ok: true });

    const c2 = await 客户(乙.id);
    const p2 = await 项目(乙.id, c2);
    当(乙);
    await 放进公海([c2]);
    await 放回公海(乙, p2);
    expect(await 领取公海项目(丙, p2)).toEqual({ ok: true });
    expect(await 负责人(c2)).toBe(乙.id);
    expect(await 在客户公海(c2)).toBe(true);
  });

  it("原负责人领回客户公海里的客户：照旧能领（团队版本来没拦）", async () => {
    公海规则.原负责人能领回 = false;
    const c = await 客户(乙.id);
    当(乙);
    await 放进公海([c]);
    expect(await 领取([c])).toMatchObject({ ok: true, updated: 1 });
  });

  it("自动掉公海照旧扫全部（一个库多人）：只是包了一层看全部", async () => {
    const 乙的 = await 客户(乙.id, { lastFollowAt: 天前(40, 今) });
    const 丙的 = await 客户(丙.id, { lastFollowAt: 天前(40, 今) });
    expect(await 自动掉公海(乙, 今)).toBe(2);
    expect(await 在客户公海(乙的)).toBe(true);
    expect(await 在客户公海(丙的)).toBe(true);
    expect(await 自动掉公海(乙, 今)).toBe(0);
  });
});
