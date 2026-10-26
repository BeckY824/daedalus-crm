/**
 * 企业版超时回收 · 夜里定时扫（Q-13，lib/project/nightly.ts）。
 *   - 钟拨到 00:05，没人打开页面，超时的项目照样回公海；00:04 还不收
 *   - 同一天跑两遍（或夜里扫过白天再打开页面），第二遍一条都不收；第二天 00:05 接着收
 *   - 服务停着错过 00:05，开机补收；当天重启不多收
 *   - 不是企业版：不起钟、扫也不收；项目模式关着、没有在职老板也不扫
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/sync/client", () => ({ 读团队: () => null }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 公海超时收回 } from "@/lib/project/db";
import { 夜里扫超时, 启动夜扫, 停夜扫, 夜扫在跑, 过了夜扫时刻 } from "@/lib/project/nightly";
import { 默认组织规则, type 组织规则 } from "@/lib/project/org-rules";
import { 超时理由 } from "@/lib/project/timeout";
import { setSetting, invalidateSettingsCache } from "@/lib/settings";

const 开着 = (节点天数: Record<string, number>): 组织规则 => ({ ...默认组织规则, 超时回收: { 开: true, 节点天数 } });
/** 服务器本地时间 */
const 时 = (s: string) => new Date(`${s.replace(" ", "T")}:00`);

let 老板: { id: string; name: string };
let 乙: string;
let 客户: string;

async function 项目(createdAt: string, 补: Record<string, unknown> = {}) {
  return prisma.project.create({ data: { name: "一号项目", customerId: 客户, ownerId: 乙, creatorId: 乙, createdAt: 时(createdAt), ...补 } });
}
const 在公海 = async (id: string) => (await prisma.project.findUniqueOrThrow({ where: { id } })).pooledAt !== null;

/** 钟往前走一分钟，等这一分钟里起的那遍扫完 */
async function 走一分钟() {
  await vi.advanceTimersByTimeAsync(60_000);
  await 夜扫在跑();
}

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  vi.stubEnv("CRM_ENTERPRISE", "1");
  const u = await prisma.user.create({ data: { email: "boss", name: "老板", title: "", role: "ADMIN", password: "x" } });
  老板 = { id: u.id, name: u.name };
  乙 = (await prisma.user.create({ data: { email: "yi", name: "乙", title: "", role: "SALES", password: "x" } })).id;
  客户 = (await prisma.customer.create({ data: { name: "客户甲", phone: "13800000001", salesOwnerId: 乙 } })).id;
  await setSetting("business", { projectMode: true });
  await setSetting("orgRules", 开着({ 潜客培育: 3 }));
});
afterEach(() => {
  停夜扫();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("过了夜扫时刻", () => {
  it("当天 00:05 起算", () => {
    expect(过了夜扫时刻(时("2026-10-25 00:04"))).toBe(false);
    expect(过了夜扫时刻(时("2026-10-25 00:05"))).toBe(true);
    expect(过了夜扫时刻(时("2026-10-25 23:59"))).toBe(true);
  });
});

describe("夜里定时扫", () => {
  it("钟拨到 00:05、没人打开页面：超时的项目回公海，留痕和待办与打开页面时一样；00:04 还不收", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(时("2026-10-24 23:58"));
    // 10-22 建的，节点 3 天 → 10-25 那天回收
    const p = await 项目("2026-10-22 10:00");
    启动夜扫();

    await 走一分钟(); // 23:59：今天（10-24）扫过一遍，还没到回收日
    expect(await 在公海(p.id)).toBe(false);
    for (let i = 0; i < 5; i++) await 走一分钟(); // 00:04
    expect(new Date().getHours() * 60 + new Date().getMinutes()).toBe(4);
    expect(await 在公海(p.id)).toBe(false);

    await 走一分钟(); // 00:05
    expect(await 在公海(p.id)).toBe(true);
    const log = await prisma.projectNodeLog.findFirstOrThrow({ where: { projectId: p.id } });
    expect(log).toMatchObject({ kind: "pool-release", fromOwnerId: 乙, toOwnerId: null, reason: 超时理由, userId: "system" }); // QA #16：记「系统」，不记打开页面 / 跑定时的那位
    expect(await prisma.task.count({ where: { ownerId: 乙 } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "pool", entity: "Project" } })).toBe(1);
  });

  it("同一天跑两遍：第二遍一条都不收；白天再打开页面也不收；第二天 00:05 接着收", async () => {
    const 早 = await 项目("2026-10-01 10:00");
    expect(await 夜里扫超时(时("2026-10-25 00:05"))).toBe(1);
    expect(await 在公海(早.id)).toBe(true);

    // 换一位客户：客户名下只有「早」一个项目，早回公海时客户也跟着进了客户公海（企业版单项目客户，pool-link.ts），
    // 公海里的客户名下的项目不再扫
    const 另一位 = (await prisma.customer.create({ data: { name: "客户乙", phone: "13800000002", salesOwnerId: 乙 } })).id;
    const 晚 = await 项目("2026-10-01 10:00", { customerId: 另一位 });
    const 之前 = { 留痕: await prisma.projectNodeLog.count(), 待办: await prisma.task.count(), 日志: await prisma.auditLog.count() };
    expect(await 夜里扫超时(时("2026-10-25 03:00"))).toBe(0);
    expect(await 公海超时收回(老板, 时("2026-10-25 09:00"))).toBe(0);
    expect(await 在公海(晚.id)).toBe(false);
    expect({ 留痕: await prisma.projectNodeLog.count(), 待办: await prisma.task.count(), 日志: await prisma.auditLog.count() }).toEqual(之前);

    expect(await 夜里扫超时(时("2026-10-26 00:05"))).toBe(1);
    expect(await 在公海(晚.id)).toBe(true);
  });

  it("服务停着错过 00:05：开机一分钟内补收；当天再重启一次，一条都不多收", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(时("2026-10-25 08:00"));
    const 早 = await 项目("2026-10-01 10:00");
    启动夜扫();
    await 走一分钟();
    expect(await 在公海(早.id)).toBe(true);

    const 晚 = await 项目("2026-10-01 10:00");
    停夜扫();
    启动夜扫();
    for (let i = 0; i < 3; i++) await 走一分钟();
    expect(await 在公海(晚.id)).toBe(false);
    expect(await prisma.projectNodeLog.count()).toBe(1);
  });

  it("不是企业版：不起钟，扫也不收（Setting 里开着、项目早超时了也一样）", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    const p = await 项目("2026-10-01 10:00");
    expect(await 夜里扫超时(时("2026-10-25 00:05"))).toBe(0);

    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(时("2026-10-25 00:04"));
    启动夜扫();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(夜扫在跑()).toBeUndefined();
    expect(await 在公海(p.id)).toBe(false);
    expect(await prisma.projectNodeLog.count()).toBe(0);
    expect(await prisma.setting.findUnique({ where: { key: "projectTimeoutSweptOn" } })).toBeNull();
  });

  it("项目模式关着、没有在职老板：不扫", async () => {
    const p = await 项目("2026-10-01 10:00");
    await setSetting("business", { projectMode: false });
    expect(await 夜里扫超时(时("2026-10-25 00:05"))).toBe(0);
    await setSetting("business", { projectMode: true });
    await prisma.user.update({ where: { id: 老板.id }, data: { active: false } });
    expect(await 夜里扫超时(时("2026-10-25 00:05"))).toBe(0);
    expect(await 在公海(p.id)).toBe(false);
  });
});
