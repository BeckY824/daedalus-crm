/**
 * 公海轻量（2026-10-03，0.46.15 第 6 块）。
 *   - 规则：N 天没跟进（没跟进过按建档）、已签约 / 已流失不掉、0 = 不开；截止线和逐条判断同一个口径
 *   - 放进公海：负责人本人或管理员；别人的跳过并数出来；原负责人不动
 *   - 领取：负责人改成我、没做完的活跟着来、公海那行删掉；已被领走的算 unchanged
 *   - 撤销：放进的拿回来；领取的还给原负责人、放回公海，活也跟着回去
 *   - 自动掉公海：没开不扫、一天一次、团队模式只扫自己名下的
 *   - 业务配置：poolDays 规整、套用预设不动它
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null as string | null },
  团队: false,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));
vi.mock("@/lib/sync/client", () => ({ 读团队: () => (mocks.团队 ? { teamId: "t", key: "k", device: "d" } : null) }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人, 造客户 } from "./r2-data-helpers";
import { invalidateSettingsCache } from "@/lib/settings";
import { saveBusiness } from "@/lib/business";
import { DEFAULT_BUSINESS, mergeBusiness, 公海天数, BUSINESS_PRESETS } from "@/lib/business-config";
import { 该掉公海, 公海截止, 公海标签 } from "@/lib/pool";
import { 自动掉公海 } from "@/lib/pool-db";
import { 放进公海, 领取, 撤销公海 } from "@/app/(app)/customers/pool-actions";
import { 客户筛选条件 } from "@/app/(app)/customers/query";

let 我: string;
let 同事: string;
beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  mocks.团队 = false;
  我 = (await 造本人()).id;
  同事 = (await prisma.user.create({ data: { email: "b@local", name: "乙", role: "SALES", password: "x" } })).id;
  mocks.user = { ...mocks.user, id: 我, role: "ADMIN" };
});
afterAll(async () => { await prisma.$disconnect(); });

const 天前 = (n: number, 今 = new Date("2026-10-03T10:00:00+08:00")) => new Date(今.getTime() - n * 86400_000);
const 今 = new Date("2026-10-03T10:00:00+08:00");

describe("规则", () => {
  it("N 天没跟进才掉；没跟进过按建档；已签约 / 已流失不掉；0 不开", () => {
    const c = (p: Partial<{ followStatus: string; lastFollowAt: Date | null; createdAt: Date }>) => ({ followStatus: "跟进中", lastFollowAt: null, createdAt: 天前(100), ...p });
    expect(该掉公海(c({ lastFollowAt: 天前(30) }), 30, 今)).toBe(true);
    expect(该掉公海(c({ lastFollowAt: 天前(29) }), 30, 今)).toBe(false);
    expect(该掉公海(c({ createdAt: 天前(31) }), 30, 今)).toBe(true);
    expect(该掉公海(c({ createdAt: 天前(3) }), 30, 今)).toBe(false);
    expect(该掉公海(c({ followStatus: "已签约", lastFollowAt: 天前(300) }), 30, 今)).toBe(false);
    expect(该掉公海(c({ followStatus: "已流失", lastFollowAt: 天前(300) }), 30, 今)).toBe(false);
    expect(该掉公海(c({ lastFollowAt: 天前(300) }), 0, 今)).toBe(false);
  });

  it("领走过的从领走那天算起", () => {
    const c = { followStatus: "跟进中", lastFollowAt: 天前(60), createdAt: 天前(100) };
    expect(该掉公海({ ...c, claimedAt: 天前(1) }, 30, 今)).toBe(false);
    expect(该掉公海({ ...c, claimedAt: 天前(30) }, 30, 今)).toBe(true);
    expect(该掉公海({ ...c, claimedAt: null }, 30, 今)).toBe(true);
  });

  it("截止线和逐条判断同一个口径（按自然日，不按 24 小时）", () => {
    const 截止 = 公海截止(30, 今);
    for (const 小时 of [0, 1, 9, 23]) {
      for (const 天 of [28, 29, 30, 31]) {
        const t = new Date(天前(天, 今).setHours(小时, 30, 0, 0));
        expect(t < 截止, `${天} 天前 ${小时} 点`).toBe(该掉公海({ followStatus: "跟进中", lastFollowAt: t, createdAt: t }, 30, 今));
      }
    }
  });

  it("标签写原负责人", () => {
    expect(公海标签("张三")).toBe("公海（原 张三）");
    expect(公海标签(null)).toBe("公海");
  });

  it("业务配置：poolDays 规整成 0–365 的整数，默认 0；预设里都是 0", () => {
    expect(mergeBusiness(null).poolDays).toBe(0);
    expect(mergeBusiness({ poolDays: 30 }).poolDays).toBe(30);
    expect(公海天数("15.7")).toBe(15);
    expect(公海天数(-3)).toBe(0);
    expect(公海天数("x")).toBe(0);
    expect(公海天数(9999)).toBe(365);
    for (const p of Object.values(BUSINESS_PRESETS)) expect(p.poolDays).toBe(0);
  });
});

describe("放进公海 / 领取 / 撤销", () => {
  it("销售只能放自己的；别人的跳过并数出来；原负责人不动", async () => {
    mocks.user = { ...mocks.user, id: 同事, role: "SALES" };
    const 他的 = await 造客户(同事);
    const 我的 = await 造客户(我);
    const r = await 放进公海([他的.id, 我的.id]);
    expect(r).toMatchObject({ ok: true, updated: 1, 没权限: 1 });
    expect(await prisma.customerPool.findMany({ select: { customerId: true, userId: true } })).toEqual([{ customerId: 他的.id, userId: 同事 }]);
    expect((await prisma.customer.findUnique({ where: { id: 他的.id } }))!.salesOwnerId).toBe(同事);
    // 全是别人的：直接说不行
    expect(await 放进公海([我的.id])).toMatchObject({ ok: false });
  });

  it("管理员能放任何人的；已在公海的算 unchanged；筛选条件只出公海里的", async () => {
    const a = await 造客户(同事);
    const b = await 造客户(同事);
    expect(await 放进公海([a.id])).toMatchObject({ ok: true, updated: 1 });
    expect(await 放进公海([a.id, b.id])).toMatchObject({ ok: true, updated: 1, unchanged: 1 });
    await 领取([b.id]);
    const 公海里 = await prisma.customer.findMany({ where: await 客户筛选条件({ pool: "1" }), select: { id: true } });
    expect(公海里.map((c) => c.id)).toEqual([a.id]);
  });

  it("领取：负责人改成我、原负责人没做完的活跟着来、做完的不动；公海那行删掉", async () => {
    const c = await 造客户(同事);
    await prisma.task.create({ data: { title: "回电话", customerId: c.id, ownerId: 同事 } });
    await prisma.task.create({ data: { title: "已做完", customerId: c.id, ownerId: 同事, done: true } });
    await prisma.customerPool.create({ data: { customerId: c.id, reason: "30 天没跟进，自动放进公海" } });
    const r = await 领取([c.id]);
    expect(r).toMatchObject({ ok: true, updated: 1, 原负责人: [{ id: c.id, 值: 同事 }] });
    expect(r.ok && r.带走?.计划和待办).toBe(1);
    expect((await prisma.customer.findUnique({ where: { id: c.id } }))!.salesOwnerId).toBe(我);
    expect(await prisma.customerPool.count()).toBe(0);
    expect((await prisma.task.findMany({ orderBy: { title: "asc" }, select: { title: true, ownerId: true } }))).toEqual([
      { title: "回电话", ownerId: 我 },
      { title: "已做完", ownerId: 同事 },
    ]);
    // 再领一次：已经不在公海，什么都不动
    expect(await 领取([c.id])).toMatchObject({ ok: true, updated: 0, unchanged: 1 });
  });

  it("撤销领取：还给原负责人、放回公海，活也跟着回去；期间被改过的不碰", async () => {
    const c = await 造客户(同事);
    const d = await 造客户(同事);
    await prisma.task.create({ data: { title: "回电话", customerId: c.id, ownerId: 同事 } });
    await prisma.customerPool.createMany({ data: [{ customerId: c.id }, { customerId: d.id }] });
    const r = await 领取([c.id, d.id]);
    if (!r.ok) throw new Error(r.error);
    // d 期间被转给了别人
    await prisma.customer.update({ where: { id: d.id }, data: { salesOwnerId: 同事 } });
    const u = await 撤销公海("领取", r.原负责人!, r.带过来);
    expect(u).toMatchObject({ ok: true, updated: 1, unchanged: 1 });
    expect((await prisma.customer.findUnique({ where: { id: c.id } }))!.salesOwnerId).toBe(同事);
    expect((await prisma.customerPool.findMany({ select: { customerId: true } })).map((x) => x.customerId)).toEqual([c.id]);
    expect((await prisma.task.findFirst({ where: { title: "回电话" } }))!.ownerId).toBe(同事);
  });

  it("撤销放进：从公海拿回来，负责人本来就没动", async () => {
    const c = await 造客户(同事);
    await 放进公海([c.id]);
    expect(await 撤销公海("放进", [{ id: c.id, 值: "" }])).toMatchObject({ ok: true, updated: 1 });
    expect(await prisma.customerPool.count()).toBe(0);
    expect((await prisma.customer.findUnique({ where: { id: c.id } }))!.salesOwnerId).toBe(同事);
  });

  it("删客户，公海那行跟着走", async () => {
    const c = await 造客户(同事);
    await 放进公海([c.id]);
    await prisma.customer.delete({ where: { id: c.id } });
    expect(await prisma.customerPool.count()).toBe(0);
  });
});

describe("复查补的几条", () => {
  it("同时点两次领取：只有一次算领到，另一次是「已被领走」", async () => {
    const c = await 造客户(同事);
    await prisma.task.create({ data: { title: "回电话", customerId: c.id, ownerId: 同事 } });
    await prisma.customerPool.create({ data: { customerId: c.id } });
    const [甲, 乙] = await Promise.all([领取([c.id]), 领取([c.id])]);
    const 领到 = [甲, 乙].map((r) => (r.ok ? r.updated : -1)).sort();
    expect(领到).toEqual([0, 1]);
    expect((await prisma.task.findFirstOrThrow({ where: { title: "回电话" } })).ownerId).toBe(我);
  });

  it("撤销领取只还领取时带过来的活，领取前就归我的不动", async () => {
    const c = await 造客户(同事);
    await prisma.task.create({ data: { title: "他的", customerId: c.id, ownerId: 同事 } });
    await prisma.task.create({ data: { title: "我早就有的", customerId: c.id, ownerId: 我 } });
    await prisma.customerPool.create({ data: { customerId: c.id } });
    const r = await 领取([c.id]);
    if (!r.ok) throw new Error(r.error);
    expect(await 撤销公海("领取", r.原负责人!, r.带过来)).toMatchObject({ ok: true, updated: 1 });
    const 活 = Object.fromEntries((await prisma.task.findMany()).map((t) => [t.title, t.ownerId]));
    expect(活).toEqual({ 他的: 同事, 我早就有的: 我 });
    expect(await prisma.customerClaim.count()).toBe(0);
  });

  it("原负责人已经停用：撤销领取不还给他，留在我这儿", async () => {
    const c = await 造客户(同事);
    await prisma.customerPool.create({ data: { customerId: c.id } });
    const r = await 领取([c.id]);
    if (!r.ok) throw new Error(r.error);
    await prisma.user.update({ where: { id: 同事 }, data: { active: false } });
    expect(await 撤销公海("领取", r.原负责人!, r.带过来)).toMatchObject({ ok: true, updated: 0, unchanged: 1 });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).salesOwnerId).toBe(我);
  });
});

describe("自动掉公海", () => {
  async function 开(天数: number) {
    await saveBusiness({ ...DEFAULT_BUSINESS, poolDays: 天数 });
  }

  it("没开不扫", async () => {
    await 造客户(同事, { lastFollowAt: 天前(300), createdAt: 天前(300) });
    expect(await 自动掉公海(mocks.user, 今)).toBe(0);
    expect(await prisma.customerPool.count()).toBe(0);
  });

  it("开了：N 天没跟进的、没跟进过且建档早的掉；签约 / 流失 / 新的 / 已在公海的不动；一天只扫一次", async () => {
    await 开(30);
    const 冷 = await 造客户(同事, { lastFollowAt: 天前(40), createdAt: 天前(100) });
    const 没跟过 = await 造客户(我, { createdAt: 天前(31) });
    await 造客户(同事, { lastFollowAt: 天前(3), createdAt: 天前(100) });
    await 造客户(同事, { followStatus: "已签约", lastFollowAt: 天前(300), createdAt: 天前(300) });
    await 造客户(同事, { followStatus: "已流失", lastFollowAt: 天前(300), createdAt: 天前(300) });
    await 造客户(同事, { createdAt: 天前(2) });
    expect(await 自动掉公海(mocks.user, 今)).toBe(2);
    const 行 = await prisma.customerPool.findMany({ select: { customerId: true, reason: true, userId: true } });
    expect(行.map((x) => x.customerId).sort()).toEqual([冷.id, 没跟过.id].sort());
    expect(行[0]).toMatchObject({ reason: "30 天没跟进，自动放进公海", userId: null });
    expect(await prisma.auditLog.count({ where: { action: "pool" } })).toBe(1);

    // 同一天再来：不扫
    await 造客户(同事, { lastFollowAt: 天前(60), createdAt: 天前(100) });
    expect(await 自动掉公海(mocks.user, 今)).toBe(0);
    // 第二天：扫到新冷下来的那位
    expect(await 自动掉公海(mocks.user, new Date(今.getTime() + 86400_000))).toBe(1);
  });

  it("领走当天没跟进：之后的扫描不把它扫回去，满 N 天才掉", async () => {
    await 开(30);
    const c = await 造客户(同事, { lastFollowAt: 天前(40), createdAt: 天前(100) });
    await prisma.customerPool.create({ data: { customerId: c.id } });
    await 领取([c.id]);
    await prisma.customerClaim.update({ where: { customerId: c.id }, data: { at: 天前(1) } });
    expect(await 自动掉公海(mocks.user, 今)).toBe(0);
    await prisma.customerClaim.update({ where: { customerId: c.id }, data: { at: 天前(31) } });
    expect(await 自动掉公海(mocks.user, new Date(今.getTime() + 86400_000))).toBe(1);
  });

  it("团队模式下只扫自己名下的（同事的跟进可能还没拉到）", async () => {
    await 开(30);
    mocks.团队 = true;
    const 我的 = await 造客户(我, { lastFollowAt: 天前(40), createdAt: 天前(100) });
    await 造客户(同事, { lastFollowAt: 天前(40), createdAt: 天前(100) });
    expect(await 自动掉公海(mocks.user, 今)).toBe(1);
    expect((await prisma.customerPool.findMany()).map((x) => x.customerId)).toEqual([我的.id]);
  });
});
