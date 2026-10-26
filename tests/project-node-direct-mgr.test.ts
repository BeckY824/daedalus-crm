/**
 * 企业版：手动往前推节点只给负责人的直属上级（D-37）和老板；虚线上级只读（D-39）。
 *   10-26 起默认「负责人可推」（负责人本人也能往前推）；下面大部分用例先切成「仅上级推」，钉的是老规矩
 *   - 负责人本人、隔级经理、虚线上级往前推：拦下；直属上级、老板：成，记的是推的人
 *   - 往后退、点结局照旧（负责人本人也能）
 *   - 一个人既是直属又是虚线：按直属算，能推
 *   - 直属上级能退回、定结果（线索流失写原因）、标异常（只在订单阶段），每次都记节点变更、记的是上级（A3 默认）
 *   - 直属上级账号还是 SALES（组织里设成销售管理不改账号角色）：照样能推，必填节点也能先推
 *   - 组织里的总管理员（账号 MANAGER）：能推所有项目，和老板一样（10-24 用户定）
 *   - 负责人没设直属上级（组织还没配）：和原来一样，本人也能推
 *   - 不是企业版：组织表配着也不拦
 *   - 「按组织架构看客户」开关关着（F10）：本人能推，和团队版一样；直属上级照样能改节点
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/sync/client", () => ({ 读团队: () => null }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 改节点, 往前推不给, 能改节点, 直属才推, 异常类别字典 } from "@/lib/project/db";
import { 读组织 } from "@/lib/enterprise/org";
import { invalidateSettingsCache, setSetting } from "@/lib/settings";
import { 默认组织规则 } from "@/lib/project/org-rules";
import { 记有效沟通 } from "./helpers/ent-valid-followup";

type 人 = { id: string; role: string };

describe("企业版推节点只给直属上级", () => {
  let 老板: 人, 经理: 人, 组长: 人, 虚: 人, 销售: 人, 散: 人;
  let 客户: string;

  async function 建(email: string, role: string): Promise<人> {
    const u = await prisma.user.create({ data: { email, name: email, title: "", role, password: "x" } });
    return { id: u.id, role };
  }
  const 项目 = (ownerId: string, 补: Record<string, unknown> = {}) =>
    prisma.project.create({ data: { name: "项目", customerId: 客户, ownerId, creatorId: ownerId, ...补 } });
  const 往前 = { phase: "线索", node: "线索验证" };
  const 仅上级 = { ...默认组织规则, 阶段: { 推进权限: "仅上级推" as const, 出口叫法: {} } };

  beforeEach(async () => {
    await resetDb();
    invalidateSettingsCache();
    老板 = await 建("boss", "ADMIN");
    经理 = await 建("mgr", "MANAGER");
    组长 = await 建("lead", "MANAGER");
    虚 = await 建("dotted", "MANAGER");
    销售 = await 建("sales", "SALES");
    散 = await 建("loose", "SALES");
    await prisma.entMember.createMany({
      data: [
        { userId: 经理.id, bizRole: "sales_mgr" },
        { userId: 组长.id, bizRole: "sales_mgr", managerId: 经理.id },
        { userId: 虚.id, bizRole: "sales_mgr" },
        { userId: 销售.id, managerId: 组长.id, dottedManagerId: 虚.id },
        { userId: 散.id },
      ],
    });
    客户 = (await prisma.customer.create({ data: { name: "客户甲", phone: "", salesOwnerId: 销售.id } })).id;
    vi.stubEnv("CRM_ENTERPRISE", "1");
    await setSetting("enterprise.rule.org_scope", true);
    await setSetting("orgRules", 仅上级);
    invalidateSettingsCache();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("本人、隔级经理、虚线上级往前推：拦下，节点不动", async () => {
    const p = await 项目(销售.id);
    const 本人 = await 改节点(销售, p.id, 往前);
    expect(本人).toEqual({ ok: false, error: "往前推节点要由你的直属上级来推" });
    for (const 谁 of [经理, 虚]) {
      expect(await 改节点(谁, p.id, 往前)).toEqual({ ok: false, error: "只有负责人的直属上级能往前推节点" });
    }
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).node).toBe("潜客培育");
    expect(await prisma.projectNodeLog.count({ where: { projectId: p.id } })).toBe(0);
  });

  it("直属上级、老板能推，记的是推的人", async () => {
    const p = await 项目(销售.id);
    await 记有效沟通(p.id);
    expect(await 改节点(组长, p.id, 往前)).toMatchObject({ ok: true });
    expect(await prisma.projectNodeLog.findFirstOrThrow({ where: { projectId: p.id, toNode: "线索验证" } })).toMatchObject({ userId: 组长.id });
    expect(await 改节点(老板, p.id, { phase: "线索", node: "线索推进" })).toMatchObject({ ok: true });
  });

  it("往后退、点结局照旧：本人也能", async () => {
    const p = await 项目(销售.id, { node: "线索推进" });
    expect(await 改节点(销售, p.id, 往前)).toMatchObject({ ok: true });
    expect(await 改节点(销售, p.id, { ...往前, result: "线索流失" }, { 备注: "联系不上" })).toMatchObject({ ok: true });
  });

  it("既是直属又是虚线：按直属算", async () => {
    await prisma.entMember.update({ where: { userId: 销售.id }, data: { dottedManagerId: 组长.id } });
    const p = await 项目(销售.id);
    expect(await 改节点(组长, p.id, 往前)).toMatchObject({ ok: true });
  });

  it("直属上级能退回、定结果、标异常（订单阶段），每次都记节点变更，记的是上级", async () => {
    const 线 = await 项目(销售.id, { node: "线索推进" });
    expect(await 改节点(组长, 线.id, 往前)).toMatchObject({ ok: true, 变了: true });
    expect(await 改节点(组长, 线.id, { ...往前, result: "线索流失" }, { 备注: "预算砍了" })).toMatchObject({ ok: true, 变了: true });
    expect(await 改节点(组长, 线.id, { ...往前, result: "异常状态" }, { categoryId: "stalled" })).toEqual({ ok: false, error: "「异常状态」只能在订单阶段点" });
    const 单 = await 项目(销售.id, { phase: "订单", node: "生产备货" });
    await 异常类别字典();
    expect(await 改节点(组长, 单.id, { phase: "订单", node: "生产备货", result: "异常状态" }, { categoryId: "stalled", 备注: "工厂停工" })).toMatchObject({ ok: true });
    const 痕 = await prisma.projectNodeLog.findMany({ where: { projectId: { in: [线.id, 单.id] } }, orderBy: [{ at: "asc" }, { id: "asc" }] });
    expect(痕.map((x) => [x.userId, x.toNode, x.toResult, x.reason])).toEqual([
      [组长.id, "线索验证", null, null],
      [组长.id, "线索验证", "线索流失", "预算砍了"],
      [组长.id, "生产备货", "异常状态", "工厂停工"],
    ]);
  });

  it("直属上级账号是 SALES：照样能推，必填节点也能先推；别人的项目还是改不了", async () => {
    const 组长2 = await 建("lead2", "SALES");
    await prisma.entMember.create({ data: { userId: 组长2.id, bizRole: "sales_mgr", managerId: 经理.id } });
    await prisma.entMember.update({ where: { userId: 销售.id }, data: { managerId: 组长2.id } });
    const p = await 项目(销售.id);
    await 记有效沟通(p.id);
    const org = await 读组织();
    expect(能改节点(组长2, { ownerId: 销售.id }, org)).toBe(true);
    expect(能改节点(组长2, { ownerId: 销售.id, pooledAt: new Date() }, org)).toBe(false);
    expect(能改节点(组长2, { ownerId: 销售.id }, null)).toBe(false);
    expect(await 改节点(组长2, p.id, 往前)).toMatchObject({ ok: true });
    expect(await prisma.projectNodeLog.findFirstOrThrow({ where: { projectId: p.id, toNode: "线索验证" } })).toMatchObject({ userId: 组长2.id });
    // 必填节点：配了必填、没填齐，直属上级照样能先推（和老板、主管一样）
    await setSetting("orgRules", { ...默认组织规则, 节点推进: { 开: true, 必填: { 线索验证: ["金额"] } } });
    invalidateSettingsCache();
    expect(await 改节点(组长2, p.id, { phase: "线索", node: "线索推进" })).toMatchObject({ ok: true });
    // 不是他下属的项目：还是改不了
    const 别人的 = await 项目(散.id);
    expect(await 改节点(组长2, 别人的.id, 往前)).toEqual({ ok: false, error: "只有项目负责人、老板或主管能改节点" });
  });

  it("总管理员（账号 MANAGER）：谁的项目都能往前推，必填节点也能先推", async () => {
    for (const bizRole of ["director", "admin"]) {
      await resetDb();
      invalidateSettingsCache();
      const 总 = await 建(`top-${bizRole}`, "MANAGER");
      const 长 = await 建(`lead-${bizRole}`, "MANAGER");
      const 卖 = await 建(`sales-${bizRole}`, "SALES");
      await prisma.entMember.createMany({ data: [
        { userId: 总.id, bizRole },
        { userId: 长.id, bizRole: "sales_mgr" },
        { userId: 卖.id, managerId: 长.id },
      ] });
      客户 = (await prisma.customer.create({ data: { name: "客户乙", phone: "", salesOwnerId: 卖.id } })).id;
      const p = await 项目(卖.id);
      await 记有效沟通(p.id);
      expect(往前推不给(总, 卖.id, await 读组织())).toBeNull();
      expect(await 改节点(总, p.id, 往前)).toMatchObject({ ok: true });
      await setSetting("orgRules", { ...默认组织规则, 节点推进: { 开: true, 必填: { 线索验证: ["金额"] } } });
      invalidateSettingsCache();
      expect(await 改节点(总, p.id, { phase: "线索", node: "线索推进" })).toMatchObject({ ok: true });
      expect(await prisma.projectNodeLog.count({ where: { projectId: p.id, userId: 总.id } })).toBe(2);
    }
  });

  it("负责人没设直属上级：照旧，本人能推", async () => {
    const p = await 项目(散.id);
    expect(await 改节点(散, p.id, 往前)).toMatchObject({ ok: true });
  });

  it("「按组织架构看客户」关着：本人能推，直属上级照样能推", async () => {
    await setSetting("enterprise.rule.org_scope", false);
    invalidateSettingsCache();
    const p = await 项目(销售.id);
    await 记有效沟通(p.id);
    expect(await 直属才推(await 读组织())).toBeNull();
    expect(await 改节点(销售, p.id, 往前)).toMatchObject({ ok: true });
    expect(await 改节点(组长, p.id, { phase: "线索", node: "线索推进" })).toMatchObject({ ok: true });
  });

  it("默认「负责人可推」（10-26）：负责人本人能往前推、记的是本人；隔级经理、虚线上级还是不行", async () => {
    await setSetting("orgRules", 默认组织规则);
    invalidateSettingsCache();
    const p = await 项目(销售.id);
    expect(往前推不给(销售, 销售.id, await 读组织(), true)).toBeNull();
    expect(await 改节点(销售, p.id, 往前)).toMatchObject({ ok: true });
    expect(await prisma.projectNodeLog.findFirstOrThrow({ where: { projectId: p.id, toNode: "线索验证" } })).toMatchObject({ userId: 销售.id });
    for (const 谁 of [经理, 虚]) {
      expect(await 改节点(谁, p.id, { phase: "线索", node: "线索推进" })).toEqual({ ok: false, error: "只有负责人的直属上级能往前推节点" });
    }
    // 本人越过线索验证：还要先有一条有效沟通
    expect(await 改节点(销售, p.id, { phase: "线索", node: "线索推进" })).toMatchObject({ ok: false, error: expect.stringContaining("明确回复") });
    await 记有效沟通(p.id);
    expect(await 改节点(销售, p.id, { phase: "线索", node: "线索推进" })).toMatchObject({ ok: true });
  });

  it("不是企业版：组织配着也不拦", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    const p = await 项目(销售.id);
    expect(await 改节点(销售, p.id, 往前)).toMatchObject({ ok: true });
    expect(往前推不给(销售, 销售.id, null)).toBeNull();
  });
});
