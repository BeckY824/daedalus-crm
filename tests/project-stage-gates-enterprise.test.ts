/**
 * 企业版三大阶段的门（10-26，lib/project/stage-gates.ts + mql.ts + db.ts 改节点 / 记项目沟通 / 按必填推进）。
 *   - 记沟通：要选项目当前阶段、要选客户是否明确回复；一条沟通一行标记（EntFollowUpMark，迁移 055）
 *   - 有效线索要至少一条有效沟通（客户明确回复了的）：没有推不过「线索验证」，手动、自动推进都拦
 *   - MQL 人工判：合格往前推到线索推进；不合格退回潜客培育 + 培育跟进计划（下一步时间 + 跟进计划）
 *   - 不是企业版：阶段、明确回复不要，一行标记不写，越过线索验证不拦，MQL 判不了
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/sync/client", () => ({ 读团队: () => null }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 改节点, 改项目, 记项目沟通 } from "@/lib/project/db";
import { 判MQL } from "@/lib/project/mql";
import { 缺有效沟通, 记沟通阶段问题 } from "@/lib/project/stage-gates";
import { 默认组织规则 } from "@/lib/project/org-rules";
import { setSetting, invalidateSettingsCache } from "@/lib/settings";
import { dayjs } from "@/lib/utils";
import { 记有效沟通 } from "./helpers/ent-valid-followup";

describe("企业版三大阶段的门", () => {
  let 老板: { id: string; role: string };
  let 乙: { id: string; role: string };
  let 客户: string;

  async function 人(email: string, role: string) {
    const u = await prisma.user.create({ data: { email, name: email, title: "", role, password: "x" } });
    return { id: u.id, role };
  }
  const 项目 = (补: Record<string, unknown> = {}) =>
    prisma.project.create({ data: { name: "一号项目", customerId: 客户, ownerId: 乙.id, creatorId: 乙.id, ...补 } });
  const 现 = (id: string) => prisma.project.findUniqueOrThrow({ where: { id } });
  const 沟通 = (补: Record<string, unknown> = {}) => ({ type: "PHONE", content: "聊了", occurredAt: dayjs().format("YYYY-MM-DD HH:mm"), ...补 });
  const 明天 = () => dayjs().add(1, "day").format("YYYY-MM-DD");

  beforeEach(async () => {
    await resetDb();
    invalidateSettingsCache();
    老板 = await 人("boss", "ADMIN");
    乙 = await 人("yi", "SALES");
    客户 = (await prisma.customer.create({ data: { name: "客户甲", phone: "", salesOwnerId: 乙.id } })).id;
    vi.stubEnv("CRM_ENTERPRISE", "1");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  describe("记沟通要选阶段 + 客户是否明确回复", () => {
    it("纯函数：没选阶段、选的不是当前阶段、没选明确回复，各给一句话；不是企业版一律 null", () => {
      expect(记沟通阶段问题({}, { phase: "线索" })).toBe("记沟通要选项目当前所在的阶段");
      expect(记沟通阶段问题({ 阶段: "随便" }, { phase: "线索" })).toBe("记沟通要选项目当前所在的阶段");
      expect(记沟通阶段问题({ 阶段: "商机" }, { phase: "线索" })).toBe("项目现在在线索阶段，沟通只能记在线索阶段");
      expect(记沟通阶段问题({ 阶段: "线索" }, { phase: "线索" })).toBe("请选客户是否明确回复");
      expect(记沟通阶段问题({ 阶段: "线索", 明确回复: "是" }, { phase: "线索" })).toBe("请选客户是否明确回复");
      expect(记沟通阶段问题({ 阶段: "线索", 明确回复: false }, { phase: "线索" })).toBeNull();
      vi.stubEnv("CRM_ENTERPRISE", "");
      expect(记沟通阶段问题({}, { phase: "线索" })).toBeNull();
    });

    it("记项目沟通：拦下时一行不写；记成一条一行标记，阶段是项目当前阶段", async () => {
      const p = await 项目({ phase: "商机", node: "明确需求" });
      expect(await 记项目沟通(乙, p.id, 沟通())).toEqual({ ok: false, error: "记沟通要选项目当前所在的阶段" });
      expect(await 记项目沟通(乙, p.id, 沟通({ 阶段: "线索", 明确回复: true }))).toEqual({ ok: false, error: "项目现在在商机阶段，沟通只能记在商机阶段" });
      expect(await 记项目沟通(乙, p.id, 沟通({ 阶段: "商机" }))).toEqual({ ok: false, error: "请选客户是否明确回复" });
      expect(await prisma.followUp.count()).toBe(0);
      expect(await prisma.entFollowUpMark.count()).toBe(0);

      const r = await 记项目沟通(乙, p.id, 沟通({ 阶段: "商机", 明确回复: true }));
      expect(r).toMatchObject({ ok: true });
      expect(await prisma.entFollowUpMark.findUniqueOrThrow({ where: { followUpId: r.followUpId! } })).toMatchObject({ projectId: p.id, phase: "商机", replied: true });
      expect(await prisma.followUpProject.findUniqueOrThrow({ where: { followUpId: r.followUpId! } })).toMatchObject({ projectId: p.id });
      const 没回 = await 记项目沟通(乙, p.id, 沟通({ 阶段: "商机", 明确回复: false }));
      expect(await prisma.entFollowUpMark.findUniqueOrThrow({ where: { followUpId: 没回.followUpId! } })).toMatchObject({ replied: false });
    });
  });

  describe("有效线索要至少一条有效沟通", () => {
    it("手动往前推过线索验证：没有有效沟通拦（老板也拦）；没明确回复的不算；记了明确回复的就能推", async () => {
      const p = await 项目({ node: "线索验证" });
      expect(await 改节点(老板, p.id, { phase: "线索", node: "线索推进" })).toEqual({ ok: false, error: 缺有效沟通 });
      expect(await 记项目沟通(乙, p.id, 沟通({ 阶段: "线索", 明确回复: false }))).toMatchObject({ ok: true });
      expect(await 改节点(老板, p.id, { phase: "线索", node: "线索推进" })).toEqual({ ok: false, error: 缺有效沟通 });
      expect((await 现(p.id)).node).toBe("线索验证");
      expect(await 记项目沟通(乙, p.id, 沟通({ 阶段: "线索", 明确回复: true }))).toMatchObject({ ok: true });
      expect(await 改节点(老板, p.id, { phase: "线索", node: "线索推进" })).toMatchObject({ ok: true });
    });

    it("线索验证以前、往后退、点结局都不看有效沟通", async () => {
      const p = await 项目();
      expect(await 改节点(乙, p.id, { phase: "线索", node: "线索验证" })).toMatchObject({ ok: true });
      const q = await 项目({ node: "线索推进" });
      expect(await 改节点(乙, q.id, { phase: "线索", node: "线索验证" })).toMatchObject({ ok: true });
      expect(await 改节点(乙, q.id, { phase: "线索", node: "线索验证", result: "线索流失" }, { 备注: "没回" })).toMatchObject({ ok: true });
    });

    it("沟通删掉了就不算（跟进没了标记留着也不算）", async () => {
      const p = await 项目({ node: "线索验证" });
      const f = await 记有效沟通(p.id);
      await prisma.followUp.delete({ where: { id: f } });
      expect(await 改节点(老板, p.id, { phase: "线索", node: "线索推进" })).toEqual({ ok: false, error: 缺有效沟通 });
    });

    it("自动推进（节点必填齐了）：没有有效沟通停在线索验证，有了接着推", async () => {
      await setSetting("orgRules", { ...默认组织规则, 节点推进: { 开: true, 必填: { 线索验证: ["金额"] } } });
      const p = await 项目({ node: "线索验证" });
      const r = await 改项目(乙, p.id, { name: "一号项目", amount: 5 });
      expect(r).not.toHaveProperty("自动推到");
      expect((await 现(p.id)).node).toBe("线索验证");
      const s = await 记项目沟通(乙, p.id, 沟通({ 阶段: "线索", 明确回复: true }));
      expect(s).toMatchObject({ ok: true, 自动推到: ["线索推进"] });
    });

    it("不是企业版：不拦、不写标记", async () => {
      vi.stubEnv("CRM_ENTERPRISE", "");
      const p = await 项目({ node: "线索验证" });
      expect(await 改节点(乙, p.id, { phase: "线索", node: "线索推进" })).toMatchObject({ ok: true });
      expect(await 记项目沟通(乙, p.id, 沟通({ 明确回复: true }))).toMatchObject({ ok: true });
      expect(await prisma.entFollowUpMark.count()).toBe(0);
    });
  });

  describe("MQL 人工判", () => {
    it("合格：往前推到线索推进（照旧要有效沟通、记节点变更）", async () => {
      const p = await 项目({ node: "线索验证" });
      expect(await 判MQL(老板, p.id, true)).toEqual({ ok: false, error: 缺有效沟通 });
      await 记有效沟通(p.id);
      expect(await 判MQL(老板, p.id, true)).toMatchObject({ ok: true });
      expect(await 现(p.id)).toMatchObject({ phase: "线索", node: "线索推进" });
      expect(await prisma.projectNodeLog.findFirstOrThrow({ where: { projectId: p.id } })).toMatchObject({ fromNode: "线索验证", toNode: "线索推进", userId: 老板.id });
    });

    it("不合格：退回潜客培育，写下一步时间 + 培育跟进计划；日期不填、早于今天拦", async () => {
      const p = await 项目({ node: "线索验证" });
      expect(await 判MQL(乙, p.id, false)).toEqual({ ok: false, error: "MQL 不合格要定下一次培育跟进的日期" });
      expect(await 判MQL(乙, p.id, false, dayjs().subtract(1, "day").format("YYYY-MM-DD"))).toEqual({ ok: false, error: "下一次培育跟进不能早于今天" });
      expect((await 现(p.id)).node).toBe("线索验证");
      expect(await prisma.followPlan.count()).toBe(0);

      expect(await 判MQL(乙, p.id, false, 明天())).toEqual({ ok: true });
      const 后 = await 现(p.id);
      expect(后).toMatchObject({ phase: "线索", node: "潜客培育" });
      expect(dayjs(后.nextStepAt).format("YYYY-MM-DD")).toBe(明天());
      const 计划 = await prisma.followPlan.findFirstOrThrow();
      expect(计划).toMatchObject({ customerId: 客户, ownerId: 乙.id, plannedOn: 明天(), done: false });
      expect(计划.subject).toContain("MQL 不合格");
    });

    it("只有停在线索验证的能判；不是企业版判不了，一行不写", async () => {
      for (const 补 of [{ node: "潜客培育" }, { node: "线索推进" }, { node: "线索验证", result: "线索流失" }, { phase: "商机", node: "明确需求" }]) {
        const p = await 项目(补);
        expect(await 判MQL(老板, p.id, false, 明天())).toEqual({ ok: false, error: "只有停在「线索验证」的项目能判 MQL" });
      }
      expect(await 判MQL(老板, "没这个", true)).toMatchObject({ ok: false, error: expect.stringContaining("不在了") });
      vi.stubEnv("CRM_ENTERPRISE", "");
      const q = await 项目({ node: "线索验证" });
      expect(await 判MQL(老板, q.id, false, 明天())).toEqual({ ok: false, error: "MQL 判定只在企业版有" });
      expect(await prisma.followPlan.count()).toBe(0);
      expect(await prisma.projectNodeLog.count()).toBe(0);
    });
  });
});
