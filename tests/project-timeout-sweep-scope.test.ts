/**
 * 超时回收「今天扫过了」的记号只管它扫过的那一片（Y18，2026-10-26）。
 *   - 企业版服务器（没有 .team.json）：谁先打开页面都是全公司扫；市场经理 00:02 先打开，别人的项目照收，00:05 那一轮不重复收
 *     按组织看客户开着时，打开页面的请求带着这个人的范围（只看得到自己 + 下属的项目），扫的时候不能跟着这个范围走（质量 3700 复测）
 *   - 团队模式（每台只扫自己名下的）：一个人先扫过，不能让同一天别人（以及全公司扫）跳过
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const 团队 = vi.hoisted(() => ({ 配置: null as null | { teamId: string; key: string; device: string } }));
vi.mock("@/lib/sync/client", () => ({ 读团队: () => 团队.配置 }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 公海超时收回 } from "@/lib/project/db";
import { 夜里扫超时 } from "@/lib/project/nightly";
import { 默认组织规则, type 组织规则 } from "@/lib/project/org-rules";
import { setSetting, invalidateSettingsCache } from "@/lib/settings";
import { 以谁的身份, 忘掉企业版范围 } from "@/lib/enterprise/visibility";
import { 规则 } from "@/lib/enterprise/rules";

const 开着 = (节点天数: Record<string, number>): 组织规则 => ({ ...默认组织规则, 超时回收: { 开: true, 节点天数 } });
/** 服务器本地时间 */
const 时 = (s: string) => new Date(`${s.replace(" ", "T")}:00`);

let 经理: { id: string; name: string };
let 乙: { id: string; name: string };
let 丙: { id: string; name: string };
let 客户: string;

async function 人(email: string, name: string, role: string) {
  const u = await prisma.user.create({ data: { email, name, title: "", role, password: "x" } });
  return { id: u.id, name: u.name };
}
async function 项目(ownerId: string, createdAt: string, customerId = 客户) {
  return prisma.project.create({ data: { name: `项目-${ownerId.slice(-4)}`, customerId, ownerId, creatorId: ownerId, createdAt: 时(createdAt) } });
}
const 在公海 = async (id: string) => (await prisma.project.findUniqueOrThrow({ where: { id } })).pooledAt !== null;

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  忘掉企业版范围();
  vi.stubEnv("CRM_ENTERPRISE", "1");
  团队.配置 = null;
  // 库里有个老板（管理员），全公司扫的口径和线上一样
  await 人("boss", "老板", "ADMIN");
  经理 = await 人("mkt", "市场经理", "MANAGER");
  乙 = await 人("yi", "乙", "SALES");
  丙 = await 人("bing", "丙", "SALES");
  客户 = (await prisma.customer.create({ data: { name: "客户甲", phone: "13800000001", salesOwnerId: 乙.id } })).id;
  await setSetting("business", { projectMode: true });
  await setSetting("orgRules", 开着({ 潜客培育: 3 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  忘掉企业版范围();
});

describe("企业版服务器：低权限先触发，也是全公司扫", () => {
  it("市场经理 00:02 先打开首页：乙、丙名下超时的都收回；00:05 夜里那一轮不重复收", async () => {
    const p乙 = await 项目(乙.id, "2026-10-22 10:00");
    const p丙 = await 项目(丙.id, "2026-10-21 10:00");
    expect(await 公海超时收回(经理, 时("2026-10-25 00:02"))).toBe(2);
    expect(await 在公海(p乙.id)).toBe(true);
    expect(await 在公海(p丙.id)).toBe(true);
    expect(await 夜里扫超时(时("2026-10-25 00:05"))).toBe(0);
    expect(await prisma.projectNodeLog.count({ where: { kind: "pool-release" } })).toBe(2);
  });

  it("按组织看客户开着、普通销售带着自己的请求身份先打开首页：同事名下超时的也收回，夜里那一轮不重复收", async () => {
    await setSetting(规则.按组织看客户.key, true);
    await prisma.entMember.createMany({ data: [{ userId: 经理.id, bizRole: "sales_mgr" }, { userId: 乙.id, managerId: 经理.id }, { userId: 丙.id, managerId: 经理.id }] });
    invalidateSettingsCache();
    忘掉企业版范围();
    const 丙的客户 = (await prisma.customer.create({ data: { name: "客户丙", phone: "13800000002", salesOwnerId: 丙.id } })).id;
    const p乙 = await 项目(乙.id, "2026-10-22 10:00");
    const p丙 = await 项目(丙.id, "2026-10-21 10:00", 丙的客户);
    // 先确认请求范围真的生效：乙带着身份只看得到自己的项目
    expect(await 以谁的身份(乙.id, () => prisma.project.count())).toBe(1);

    expect(await 以谁的身份(乙.id, () => 公海超时收回(乙, 时("2026-10-25 00:02")))).toBe(2);
    expect(await 在公海(p乙.id)).toBe(true);
    expect(await 在公海(p丙.id)).toBe(true);
    expect(await prisma.task.count({ where: { ownerId: 丙.id } })).toBe(1);
    expect(await 夜里扫超时(时("2026-10-25 00:05"))).toBe(0);
    expect(await prisma.projectNodeLog.count({ where: { kind: "pool-release" } })).toBe(2);
  });
});

describe("开关关闭时不变（个人版、团队版）", () => {
  it("库里存着开的超时规则也不收、不记扫过的号", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    const p乙 = await 项目(乙.id, "2026-10-01 10:00");
    for (const 配置 of [null, { teamId: "t1", key: "k", device: "d" }]) {
      团队.配置 = 配置;
      expect(await 公海超时收回(乙, 时("2026-10-25 09:00"))).toBe(0);
    }
    expect(await 夜里扫超时(时("2026-10-25 00:05"))).toBe(0);
    expect(await 在公海(p乙.id)).toBe(false);
    expect(await prisma.projectNodeLog.count({ where: { kind: "pool-release" } })).toBe(0);
    expect(await prisma.setting.count({ where: { key: { startsWith: "projectTimeoutSweptOn" } } })).toBe(0);
  });
});

describe("团队模式：只扫自己名下的那次不记全公司的号", () => {
  beforeEach(() => {
    团队.配置 = { teamId: "t1", key: "k", device: "d" };
  });

  it("乙先打开（只收乙的），丙同一天再打开照样收丙的", async () => {
    const p乙 = await 项目(乙.id, "2026-10-22 10:00");
    const p丙 = await 项目(丙.id, "2026-10-22 10:00");
    expect(await 公海超时收回(乙, 时("2026-10-25 09:00"))).toBe(1);
    expect(await 在公海(p乙.id)).toBe(true);
    expect(await 在公海(p丙.id)).toBe(false);

    expect(await 公海超时收回(丙, 时("2026-10-25 09:30"))).toBe(1);
    expect(await 在公海(p丙.id)).toBe(true);
  });

  it("同一个人同一天按同一份规则只扫一次", async () => {
    await 项目(乙.id, "2026-10-22 10:00");
    expect(await 公海超时收回(乙, 时("2026-10-25 09:00"))).toBe(1);
    const 晚到的 = await 项目(乙.id, "2026-10-01 10:00");
    expect(await 公海超时收回(乙, 时("2026-10-25 15:00"))).toBe(0);
    expect(await 在公海(晚到的.id)).toBe(false);
  });

  it("低权限先扫过自己的，再全公司扫（切回服务器口径）仍收得到别人的", async () => {
    const p乙 = await 项目(乙.id, "2026-10-22 10:00");
    const p丙 = await 项目(丙.id, "2026-10-22 10:00");
    expect(await 公海超时收回(乙, 时("2026-10-25 00:02"))).toBe(1);
    团队.配置 = null;
    expect(await 夜里扫超时(时("2026-10-25 00:05"))).toBe(1);
    expect(await 在公海(p乙.id)).toBe(true);
    expect(await 在公海(p丙.id)).toBe(true);
  });
});
