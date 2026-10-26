/**
 * 企业版提成 + 组长分配（2026-10-26，迁移 051）。
 * 钉的是：2% / 30% 怎么算、成交低于底价溢价算 0；改 A / B 进操作记录；分配合计不能超 100%、剩下的归组长；
 * 组长以外的销售改不了分配；赢单（进订单）那一刻固定实际提成；开关关着照旧——一行不写、卡片不出。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
import { 存项目底价, 存提成分配, 改提成比例 } from "@/app/(app)/projects/commission-actions";
import { 读项目提成, 读提成比例 } from "@/lib/project/commission-db";
import { 改节点 } from "@/lib/project/db";
import { 算提成, 分到每人, 分配问题, 默认提成比例 } from "@/lib/project/commission";
import { invalidateSettingsCache } from "@/lib/settings";

let 甲: string; // 老板
let 乙: string; // 组长（项目负责人）
let 丙: string; // 已进组的组员
let 丁: string; // 邀请了还没同意
let 项目id: string;

const 记录 = () => prisma.auditLog.findMany({ orderBy: { at: "asc" }, select: { entity: true, entityId: true, summary: true } });
const 当 = (id: string, role: string) => { mocks.user = { ...mocks.user, id, role }; };
const 名 = (uid: string) => ({ [甲]: "甲", [乙]: "乙", [丙]: "丙", [丁]: "丁" })[uid] ?? "?";
const 卡 = async (who: { id: string; role: string }) => {
  const p = await prisma.project.findUniqueOrThrow({ where: { id: 项目id } });
  const 在组 = (await prisma.projectMember.findMany({ where: { projectId: 项目id, inviteStatus: "JOINED" } })).map((m) => m.userId);
  return 读项目提成(who, p, 在组, null, 名, prisma);
};

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  vi.stubEnv("CRM_ENTERPRISE", "1");
  mocks.开 = true;
  甲 = (await prisma.user.create({ data: { email: "jia", name: "甲", title: "", role: "ADMIN", password: "x" } })).id;
  乙 = (await prisma.user.create({ data: { email: "yi", name: "乙", title: "", role: "SALES", password: "x" } })).id;
  丙 = (await prisma.user.create({ data: { email: "bing", name: "丙", title: "", role: "SALES", password: "x" } })).id;
  丁 = (await prisma.user.create({ data: { email: "ding", name: "丁", title: "", role: "SALES", password: "x" } })).id;
  当(甲, "ADMIN");
  const c = await prisma.customer.create({ data: { name: "客户", phone: "13800000001", salesOwnerId: 乙 } });
  项目id = (await prisma.project.create({
    data: { name: "一期", customerId: c.id, ownerId: 乙, creatorId: 乙, phase: "商机", node: "首款支付", amount: 120000 },
  })).id;
  await prisma.projectMember.createMany({
    data: [
      { projectId: 项目id, userId: 乙, inviteStatus: "JOINED" },
      { projectId: 项目id, userId: 丙, inviteStatus: "JOINED" },
      { projectId: 项目id, userId: 丁, inviteStatus: "INVITED" },
    ],
  });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("算法", () => {
  it("底价 × 2% + (成交 − 底价) × 30%", () => {
    expect(算提成(120000, 100000, 默认提成比例)).toEqual({
      成交金额: 120000, 项目底价: 100000, 项目溢价: 20000, 底价提成: 2000, 溢价提成: 6000, 合计: 8000,
    });
  });
  it("成交低于底价：溢价算 0，不出负数", () => {
    expect(算提成(80000, 100000, 默认提成比例)).toMatchObject({ 项目溢价: 0, 底价提成: 2000, 溢价提成: 0, 合计: 2000 });
  });
  it("底价没填不出数", () => {
    expect(算提成(120000, null, 默认提成比例)).toBeNull();
  });
  it("没设过比例：默认 2% / 30%", async () => {
    expect(await 读提成比例()).toEqual({ 底价比例: 2, 溢价比例: 30 });
  });
  it("分配合计超 100% 报错；正好 100% 行", () => {
    expect(分配问题({ a: 60, b: 40.01 })).toMatch(/超过 100%/);
    expect(分配问题({ a: 60, b: 40 })).toBeNull();
    expect(分配问题({ a: 0.1, b: 0.2, c: 99.7 })).toBeNull();
  });
  it("剩下的（含零头）归组长；不在组的那份回到组长", () => {
    const 在组 = new Set(["组长", "x", "y"]);
    expect(分到每人(100, "组长", [{ userId: "x", percent: 33.33 }, { userId: "y", percent: 33.33 }, { userId: "走了", percent: 20 }], 在组)).toEqual([
      { userId: "组长", 比例: 33.34, 金额: 33.34, 组长: true },
      { userId: "x", 比例: 33.33, 金额: 33.33, 组长: false },
      { userId: "y", 比例: 33.33, 金额: 33.33, 组长: false },
    ]);
  });
});

describe("提成比例 A / B", () => {
  it("老板改了进操作记录；没改动不记", async () => {
    expect(await 改提成比例({ 底价比例: 3, 溢价比例: 25 })).toEqual({ ok: true, 变了: true });
    expect(await 改提成比例({ 底价比例: 3, 溢价比例: 25 })).toEqual({ ok: true, 变了: false });
    expect(await 读提成比例()).toEqual({ 底价比例: 3, 溢价比例: 25 });
    expect(await 记录()).toEqual([
      { entity: "Setting", entityId: "entCommissionRates", summary: "提成比例：底价 2% → 3%，溢价 30% → 25%" },
    ]);
  });
  it("销售改不了；超出 0–100 拦", async () => {
    当(乙, "SALES");
    expect(await 改提成比例({ 底价比例: 3, 溢价比例: 25 })).toMatchObject({ ok: false, error: expect.stringContaining("只有老板") });
    当(甲, "ADMIN");
    expect(await 改提成比例({ 底价比例: 101, 溢价比例: 25 })).toMatchObject({ ok: false });
    expect(await prisma.setting.findUnique({ where: { key: "entCommissionRates" } })).toBeNull();
    expect(await 记录()).toEqual([]);
  });
});

describe("项目底价和分配", () => {
  it("组长填底价、分给组员；预估按现在的比例，剩下归组长；各记一条操作记录", async () => {
    当(乙, "SALES");
    expect(await 存项目底价(项目id, 100000)).toEqual({ ok: true, 变了: true });
    expect(await 存提成分配(项目id, { [丙]: 30 })).toEqual({ ok: true, 变了: true });
    const t = (await 卡({ id: 乙, role: "SALES" }))!;
    expect(t.预估).toMatchObject({ 成交金额: 120000, 项目底价: 100000, 项目溢价: 20000, 合计: 8000 });
    expect(t.实际).toBeNull();
    expect(t.每人).toEqual([
      { userId: 乙, name: "乙", 比例: 70, 金额: 5600, 组长: true },
      { userId: 丙, name: "丙", 比例: 30, 金额: 2400, 组长: false },
    ]);
    expect(t.能改).toBe(true);
    expect(t.组员).toEqual([{ userId: 丙, name: "丙" }]);
    expect(await 记录()).toEqual([
      { entity: "EntCommission", entityId: 项目id, summary: "项目「一期」的项目底价：空 → 100000" },
      { entity: "EntCommission", entityId: 项目id, summary: "项目「一期」的提成分配：丙 30%，组长 70%" },
    ]);
  });

  it("合计超 100% 拦，一行不写", async () => {
    当(乙, "SALES");
    expect(await 存提成分配(项目id, { [丙]: 100.5 })).toMatchObject({ ok: false });
    expect(await prisma.entCommissionSplit.count()).toBe(0);
    expect(await 记录()).toEqual([]);
  });

  it("只能分给已进组的人：没同意邀请的、组长自己都拦", async () => {
    当(乙, "SALES");
    expect(await 存提成分配(项目id, { [丁]: 10 })).toMatchObject({ ok: false, error: expect.stringContaining("已经进组") });
    expect(await 存提成分配(项目id, { [乙]: 10 })).toMatchObject({ ok: false, error: expect.stringContaining("组长自己") });
    expect(await prisma.entCommissionSplit.count()).toBe(0);
  });

  it("组长以外的销售（哪怕是组员）改不了分配、底价", async () => {
    当(丙, "SALES");
    expect(await 存提成分配(项目id, { [丙]: 90 })).toMatchObject({ ok: false, error: expect.stringContaining("只有组长") });
    expect(await 存项目底价(项目id, 1)).toMatchObject({ ok: false });
    expect(await prisma.entCommissionSplit.count()).toBe(0);
    expect(await prisma.entCommission.count()).toBe(0);
    expect(await 记录()).toEqual([]);
    // 组员能看、不能改
    expect(await 卡({ id: 丙, role: "SALES" })).toMatchObject({ 能改: false });
    // 不在组的销售看不到
    expect(await 卡({ id: 丁, role: "SALES" })).toBeNull();
  });

  it("老板也能改分配", async () => {
    expect(await 存提成分配(项目id, { [丙]: 50 })).toEqual({ ok: true, 变了: true });
  });

  it("项目底价只有项目负责人填：老板、总管理员也不代填，一行不写、不记", async () => {
    当(甲, "ADMIN");
    expect(await 存项目底价(项目id, 100000)).toMatchObject({ ok: false, error: "项目底价由项目负责人填" });
    expect(await prisma.entCommission.count()).toBe(0);
    expect(await 记录()).toEqual([]);
    // 卡片上：老板能改分配、不能填底价；负责人两样都能；组员都不能
    expect(await 卡({ id: 甲, role: "ADMIN" })).toMatchObject({ 能改: true, 能填底价: false });
    expect(await 卡({ id: 乙, role: "SALES" })).toMatchObject({ 能改: true, 能填底价: true });
    expect(await 卡({ id: 丙, role: "SALES" })).toMatchObject({ 能改: false, 能填底价: false });
    当(乙, "SALES");
    expect(await 存项目底价(项目id, 100000)).toEqual({ ok: true, 变了: true });
  });

  it("成交金额低于项目底价：项目溢价算 0，提成只剩底价那份，不出负数", async () => {
    当(乙, "SALES");
    await 存项目底价(项目id, 100000);
    await prisma.project.update({ where: { id: 项目id }, data: { amount: 80000 } });
    const t = (await 卡({ id: 乙, role: "SALES" }))!;
    expect(t.预估).toMatchObject({ 成交金额: 80000, 项目底价: 100000, 项目溢价: 0, 合计: 2000 });
    expect(t.每人.every((x) => (x.金额 ?? 0) >= 0)).toBe(true);
    // 正好等于底价：溢价也是 0
    await prisma.project.update({ where: { id: 项目id }, data: { amount: 100000 } });
    expect((await 卡({ id: 乙, role: "SALES" }))!.预估).toMatchObject({ 项目溢价: 0, 合计: 2000 });
  });
});

describe("赢单固定实际提成", () => {
  it("进订单那一刻按当时的比例固定；之后改比例、改金额不动实际；退回商机清掉", async () => {
    当(乙, "SALES");
    await 存项目底价(项目id, 100000);
    await 存提成分配(项目id, { [丙]: 25 });
    当(甲, "ADMIN");
    expect(await 改节点(mocks.user, 项目id, { phase: "订单", node: "生产备货" })).toMatchObject({ ok: true, 变了: true });
    const c = await prisma.entCommission.findUniqueOrThrow({ where: { projectId: 项目id } });
    expect(c).toMatchObject({ fixedDeal: 120000, fixedBase: 100000, fixedRateBase: 2, fixedRatePremium: 30, fixedTotal: 8000 });
    expect(c.fixedAt).toBeInstanceOf(Date);

    await 改提成比例({ 底价比例: 5, 溢价比例: 50 });
    await prisma.project.update({ where: { id: 项目id }, data: { amount: 200000 } });
    const t = (await 卡({ id: 乙, role: "SALES" }))!;
    expect(t.实际).toMatchObject({ 成交金额: 120000, 项目底价: 100000, 合计: 8000, 比例: { 底价比例: 2, 溢价比例: 30 } });
    expect(t.预估?.合计).toBe(55000); // 预估跟着现在的比例和金额走，只作参考
    expect(t.每人.map((x) => x.金额)).toEqual([6000, 2000]); // 分按实际提成算

    // 固定了以后底价不能改
    当(乙, "SALES");
    expect(await 存项目底价(项目id, 90000)).toMatchObject({ ok: false, error: expect.stringContaining("已经赢单") });

    当(甲, "ADMIN");
    expect(await 改节点(mocks.user, 项目id, { phase: "商机", node: "首款支付" })).toMatchObject({ ok: true });
    expect(await prisma.entCommission.findUniqueOrThrow({ where: { projectId: 项目id } })).toMatchObject({ fixedAt: null, fixedTotal: null, basePrice: 100000 });
    expect((await 卡({ id: 乙, role: "SALES" }))!.实际).toBeNull();
  });

  it("没填底价就赢单：在订单阶段补填底价时固定", async () => {
    expect(await 改节点(mocks.user, 项目id, { phase: "订单", node: "生产备货" })).toMatchObject({ ok: true });
    expect(await prisma.entCommission.findUnique({ where: { projectId: 项目id } })).toBeNull();
    当(乙, "SALES");
    expect(await 存项目底价(项目id, 100000)).toEqual({ ok: true, 变了: true });
    expect(await prisma.entCommission.findUniqueOrThrow({ where: { projectId: 项目id } })).toMatchObject({ fixedTotal: 8000 });
  });
});

describe("开关关着照旧", () => {
  it("不是企业版：三个动作都拦，一行不写、不记；卡片不出；进订单不建提成表", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    当(乙, "SALES");
    expect(await 存项目底价(项目id, 100000)).toMatchObject({ ok: false, error: "提成是企业版的功能" });
    expect(await 存提成分配(项目id, { [丙]: 30 })).toMatchObject({ ok: false, error: "提成是企业版的功能" });
    当(甲, "ADMIN");
    expect(await 改提成比例({ 底价比例: 3, 溢价比例: 25 })).toMatchObject({ ok: false, error: "提成是企业版的功能" });
    expect(await 卡({ id: 甲, role: "ADMIN" })).toBeNull();
    expect(await 改节点(mocks.user, 项目id, { phase: "订单", node: "生产备货" })).toMatchObject({ ok: true });
    expect(await prisma.entCommission.count()).toBe(0);
    expect(await prisma.entCommissionSplit.count()).toBe(0);
    expect(await prisma.setting.findUnique({ where: { key: "entCommissionRates" } })).toBeNull();
    expect((await 记录()).filter((r) => r.entity === "EntCommission" || r.entity === "Setting")).toEqual([]);
  });

  it("项目模式没开：同样拦", async () => {
    mocks.开 = false;
    expect(await 存项目底价(项目id, 100000)).toMatchObject({ ok: false, error: expect.stringContaining("没开") });
    expect(await 存提成分配(项目id, { [丙]: 30 })).toMatchObject({ ok: false, error: expect.stringContaining("没开") });
    expect(await 改提成比例({ 底价比例: 3, 溢价比例: 25 })).toMatchObject({ ok: false, error: expect.stringContaining("没开") });
    expect(await prisma.entCommission.count()).toBe(0);
    expect(await 记录()).toEqual([]);
  });
});
