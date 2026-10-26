/**
 * 企业版超时回收（D-34，lib/project/timeout.ts + lib/project/db.ts 公海超时收回 / 超时预览 / 记项目沟通）。
 *   - 回收日：起点 + 节点天数；下一步时间那天过完也收，但不比节点天数晚；比起点早的下一步不算
 *   - 扫库：没开不扫；没设时长的节点、订单阶段、有结局的、已在公海的不收；收了留痕（理由写超时）+ 负责人一条待办
 *   - 一天按同一份规则扫一次，规则改了当天再扫；团队模式只扫自己名下的
 *   - 记沟通：开了超时回收的线索 / 商机阶段要下一步时间；谁能记；跟进推后起点
 *   - 不是企业版（CRM_ENTERPRISE 不设）：Setting 里开着也不扫、记沟通不要下一步时间
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({ 团队: false }));
vi.mock("@/lib/sync/client", () => ({ 读团队: () => (mocks.团队 ? { teamId: "t", key: "k", device: "d" } : null) }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 公海超时收回, 超时预览, 记项目沟通 } from "@/lib/project/db";
import { 超时回收日, 已超时, 超时理由, 超时起点 } from "@/lib/project/timeout";
import { 默认组织规则, type 组织规则 } from "@/lib/project/org-rules";
import { 要下一步时间, 规整向导 } from "@/lib/project/wizard";
import { setSetting, invalidateSettingsCache } from "@/lib/settings";
import { dayjs } from "@/lib/utils";

const 开着 = (节点天数: Record<string, number>): 组织规则 => ({ ...默认组织规则, 超时回收: { 开: true, 节点天数 } });

describe("超时起点", () => {
  it("取最晚的那个，空的跳过", () => {
    const 早 = new Date("2026-10-01T08:00:00Z"), 晚 = new Date("2026-10-05T08:00:00Z");
    expect(超时起点(早, null, 晚, undefined).getTime()).toBe(晚.getTime());
    expect(超时起点(晚, "2026-10-01T00:00:00Z").getTime()).toBe(晚.getTime());
    expect(超时起点(早).getTime()).toBe(早.getTime());
  });
});

describe("超时回收日", () => {
  const 规则 = 开着({ 潜客培育: 7, 明确需求: 3 });
  const 起 = "2026-10-01T10:00:00";

  it("起点 + 节点天数；那天到了就算超时", () => {
    expect(超时回收日(规则, { phase: "线索", node: "潜客培育" }, 起)).toBe("2026-10-08");
    expect(已超时("2026-10-08", "2026-10-07T23:59:00")).toBe(false);
    expect(已超时("2026-10-08", "2026-10-08T00:01:00")).toBe(true);
    expect(已超时(null)).toBe(false);
  });

  it("没开、没设时长的节点、订单阶段、有结局、在公海：不收", () => {
    expect(超时回收日(默认组织规则, { phase: "线索", node: "潜客培育" }, 起)).toBeNull();
    expect(超时回收日(规则, { phase: "线索", node: "线索验证" }, 起)).toBeNull();
    expect(超时回收日(开着({ 潜客培育: 7 }), { phase: "订单", node: "潜客培育" }, 起)).toBeNull();
    expect(超时回收日(规则, { phase: "线索", node: "潜客培育", result: "线索流失" }, 起)).toBeNull();
    expect(超时回收日(规则, { phase: "线索", node: "潜客培育", pooledAt: new Date() }, 起)).toBeNull();
  });

  it("下一步时间：那天过完还没动静就收；比节点天数晚的不延长；比起点早的（过时的）不算", () => {
    expect(超时回收日(规则, { phase: "线索", node: "潜客培育", nextStepAt: "2026-10-03T15:00:00" }, 起)).toBe("2026-10-04");
    expect(超时回收日(规则, { phase: "线索", node: "潜客培育", nextStepAt: "2026-10-01T09:00:00" }, 起)).toBe("2026-10-02");
    expect(超时回收日(规则, { phase: "线索", node: "潜客培育", nextStepAt: "2026-10-20" }, 起)).toBe("2026-10-08");
    expect(超时回收日(规则, { phase: "线索", node: "潜客培育", nextStepAt: "2026-09-28" }, 起)).toBe("2026-10-08");
  });
});

describe("扫库收回", () => {
  let 老板: { id: string; name: string; role: string };
  let 乙: { id: string; name: string; role: string };
  let 丙: { id: string; name: string; role: string };
  let 客户: string;

  async function 人(email: string, role: string) {
    const u = await prisma.user.create({ data: { email, name: email, title: "", role, password: "x" } });
    return { id: u.id, name: u.name, role };
  }
  async function 项目(ownerId: string, 补: Record<string, unknown> = {}) {
    return prisma.project.create({ data: { name: "一号项目", customerId: 客户, ownerId, creatorId: ownerId, ...补 } });
  }
  const 天后 = (n: number) => dayjs().add(n, "day").toDate();

  beforeEach(async () => {
    await resetDb();
    invalidateSettingsCache();
    mocks.团队 = false;
    老板 = await 人("boss", "ADMIN");
    乙 = await 人("yi", "SALES");
    丙 = await 人("bing", "SALES");
    客户 = (await prisma.customer.create({ data: { name: "客户甲", phone: "13800000001", salesOwnerId: 乙.id } })).id;
    vi.stubEnv("CRM_ENTERPRISE", "1");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("不是企业版：Setting 里开着也不扫、不收；记沟通不要下一步时间", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    await setSetting("orgRules", 开着({ 潜客培育: 1 }));
    const p = await 项目(乙.id);
    expect(await 公海超时收回(老板, 天后(400))).toBe(0);
    expect(await prisma.project.count({ where: { pooledAt: { not: null } } })).toBe(0);
    const r = await 记项目沟通(乙, p.id, { type: "PHONE", content: "聊了报价", occurredAt: dayjs().format("YYYY-MM-DD HH:mm") });
    expect(r.ok).toBe(true);
  });

  it("没开：什么都不做", async () => {
    await 项目(乙.id);
    expect(await 公海超时收回(老板, 天后(400))).toBe(0);
    expect(await prisma.project.count({ where: { pooledAt: { not: null } } })).toBe(0);
  });

  it("超时的回公海：留痕写理由、负责人一条待办、清下一步时间；没到的、没设时长的、订单的、有结局的不动", async () => {
    await setSetting("orgRules", 开着({ 潜客培育: 3, 明确需求: 10, 生产备货: 1 }));
    const 超 = await 项目(乙.id, { nextStepAt: 天后(1) });
    const 没到 = await 项目(乙.id, { phase: "商机", node: "明确需求" });
    const 没设 = await 项目(乙.id, { node: "线索验证" });
    const 订单 = await 项目(乙.id, { phase: "订单", node: "生产备货" });
    const 结局 = await 项目(乙.id, { result: "线索流失" });

    expect(await 超时预览(开着({ 潜客培育: 3, 明确需求: 10 }), 天后(5))).toBe(1);
    expect(await 公海超时收回(老板, 天后(5))).toBe(1);

    const 现 = await prisma.project.findUniqueOrThrow({ where: { id: 超.id } });
    expect(现.pooledAt).not.toBeNull();
    expect(现.nextStepAt).toBeNull();
    expect(现.ownerId).toBe(乙.id);
    for (const id of [没到.id, 没设.id, 订单.id, 结局.id]) {
      expect((await prisma.project.findUniqueOrThrow({ where: { id } })).pooledAt).toBeNull();
    }
    const log = await prisma.projectNodeLog.findFirstOrThrow({ where: { projectId: 超.id } });
    expect(log).toMatchObject({ kind: "pool-release", fromOwnerId: 乙.id, toOwnerId: null, reason: 超时理由, userId: "system" }); // QA #16：记「系统」，不记打开页面 / 跑定时的那位
    const 待办 = await prisma.task.findMany({ where: { ownerId: 乙.id } });
    expect(待办).toHaveLength(1);
    expect(待办[0].title).toContain("「一号项目」在「潜客培育」超过处理时长");
    expect(待办[0].customerId).toBe(客户);
    expect(await prisma.auditLog.count({ where: { action: "pool", entity: "Project" } })).toBe(1);
  });

  it("下一步时间比节点时长早：下一步那天过完就收", async () => {
    await setSetting("orgRules", 开着({ 潜客培育: 30 }));
    await 项目(乙.id, { nextStepAt: 天后(2) });
    expect(await 公海超时收回(老板, 天后(2))).toBe(0);
    invalidateSettingsCache();
    await setSetting("projectTimeoutSweptOn", null);
    expect(await 公海超时收回(老板, 天后(3))).toBe(1);
  });

  it("客户上记了跟进、节点刚推过：起点往后挪，不收", async () => {
    await setSetting("orgRules", 开着({ 潜客培育: 3 }));
    const p = await 项目(乙.id, { createdAt: 天后(-10) });
    await prisma.customer.update({ where: { id: 客户 }, data: { lastFollowAt: 天后(-1) } });
    expect(await 超时预览(开着({ 潜客培育: 3 }))).toBe(0);
    await prisma.customer.update({ where: { id: 客户 }, data: { lastFollowAt: null } });
    await prisma.projectNodeLog.create({ data: { projectId: p.id, userId: 乙.id, at: 天后(-1), fromPhase: "线索", fromNode: "潜客培育", toPhase: "线索", toNode: "潜客培育" } });
    expect(await 超时预览(开着({ 潜客培育: 3 }))).toBe(0);
    expect(await 超时预览(开着({ 潜客培育: 1 }))).toBe(1);
  });

  it("同一天同一份规则只扫一次；改了时长当天再扫", async () => {
    await setSetting("orgRules", 开着({ 潜客培育: 30 }));
    await 项目(乙.id);
    expect(await 公海超时收回(老板, 天后(5))).toBe(0);
    await 项目(乙.id, { createdAt: 天后(-40) });
    expect(await 公海超时收回(老板, 天后(5))).toBe(0);
    await setSetting("orgRules", 开着({ 潜客培育: 3 }));
    invalidateSettingsCache();
    expect(await 公海超时收回(老板, 天后(5))).toBe(2);
  });

  it("客户在客户公海里：项目不收，等人领客户一起带走；客户被领走后照常算", async () => {
    await setSetting("orgRules", 开着({ 潜客培育: 3 }));
    const p = await 项目(乙.id);
    await prisma.customerPool.create({ data: { customerId: 客户, userId: 乙.id } });
    expect(await 超时预览(开着({ 潜客培育: 3 }), 天后(5))).toBe(0);
    expect(await 公海超时收回(老板, 天后(5))).toBe(0);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).pooledAt).toBeNull();
    expect(await prisma.task.count()).toBe(0);

    await prisma.customerPool.delete({ where: { customerId: 客户 } });
    invalidateSettingsCache();
    await setSetting("projectTimeoutSweptOn", null);
    expect(await 公海超时收回(老板, 天后(5))).toBe(1);
  });

  it("团队模式只扫自己名下的", async () => {
    mocks.团队 = true;
    await setSetting("orgRules", 开着({ 潜客培育: 3 }));
    await 项目(乙.id);
    const 丙的 = await 项目(丙.id);
    expect(await 公海超时收回(丙, 天后(5))).toBe(1);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: 丙的.id } })).pooledAt).not.toBeNull();
    expect(await prisma.project.count({ where: { pooledAt: null } })).toBe(1);
  });

  describe("记项目沟通", () => {
    const 沟通 = (补: Record<string, unknown> = {}) => ({ type: "PHONE", content: "聊了报价", occurredAt: dayjs().format("YYYY-MM-DD HH:mm"), ...补 });

    it("开了超时回收：线索 / 商机阶段不填下一步时间不让存，说清楚缺什么；订单阶段不要", async () => {
      await setSetting("orgRules", 开着({ 潜客培育: 3 }));
      const p = await 项目(乙.id);
      expect(await 记项目沟通(乙, p.id, 沟通())).toEqual({ ok: false, error: 要下一步时间 });
      expect(await 记项目沟通(乙, p.id, 沟通({ 下一步时间: dayjs().subtract(1, "day").format("YYYY-MM-DD") }))).toEqual({ ok: false, error: "下一步时间不能早于今天" });
      const 下一步 = dayjs().add(2, "day").format("YYYY-MM-DD");
      const r = await 记项目沟通(乙, p.id, 沟通({ 下一步时间: 下一步 }));
      expect(r.ok).toBe(true);
      const 现 = await prisma.project.findUniqueOrThrow({ where: { id: p.id } });
      expect(dayjs(现.nextStepAt).format("YYYY-MM-DD")).toBe(下一步);
      expect(await prisma.followUpProject.findUniqueOrThrow({ where: { followUpId: r.followUpId! } })).toMatchObject({ projectId: p.id, node: "潜客培育" });
      expect((await prisma.customer.findUniqueOrThrow({ where: { id: 客户 } })).lastFollowAt).not.toBeNull();

      const 订单 = await 项目(乙.id, { phase: "订单", node: "生产备货" });
      expect((await 记项目沟通(乙, 订单.id, 沟通())).ok).toBe(true);
    });

    it("没开：下一步时间可填可不填", async () => {
      const p = await 项目(乙.id);
      expect((await 记项目沟通(乙, p.id, 沟通())).ok).toBe(true);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).nextStepAt).toBeNull();
    });

    it("谁能记：负责人、老板、进了组的成员；别人、在公海里的不行", async () => {
      const p = await 项目(乙.id);
      expect(await 记项目沟通(丙, p.id, 沟通())).toEqual({ ok: false, error: "只有项目负责人、项目组成员、老板或主管能记沟通" });
      await prisma.projectMember.create({ data: { projectId: p.id, userId: 丙.id, inviteStatus: "JOINED", invitedById: 乙.id } });
      expect((await 记项目沟通(丙, p.id, 沟通())).ok).toBe(true);
      expect((await 记项目沟通(老板, p.id, 沟通())).ok).toBe(true);
      await prisma.project.update({ where: { id: p.id }, data: { pooledAt: new Date() } });
      expect(await 记项目沟通(乙, p.id, 沟通())).toEqual({ ok: false, error: "这个项目在公海里，先领取再记" });
      expect(await 记项目沟通(乙, "没这个", 沟通())).toMatchObject({ ok: false, error: expect.stringContaining("不在了") });
    });
  });
});

describe("建档向导：开了超时回收首条跟进要下一步时间", () => {
  const 输入 = (下一步时间?: string) => ({
    联系人: { name: "张三" },
    项目: { name: "项目" },
    跟进: { type: "PHONE", content: "聊了", occurredAt: dayjs().format("YYYY-MM-DD HH:mm"), 下一步时间 },
  });
  it("没开不要；开了不填报错；填了带出来", () => {
    expect("error" in 规整向导({ id: "me" }, 输入() as never)).toBe(false);
    expect(规整向导({ id: "me" }, 输入() as never, new Date(), true)).toEqual({ error: 要下一步时间 });
    const r = 规整向导({ id: "me" }, 输入(dayjs().add(1, "day").format("YYYY-MM-DD")) as never, new Date(), true);
    expect("error" in r ? r.error : r.跟进.nextStepAt).toBeInstanceOf(Date);
  });
});
