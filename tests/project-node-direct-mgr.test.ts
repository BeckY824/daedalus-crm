/**
 * 企业版：手动往前推节点只给负责人的直属上级（D-37）和老板；虚线上级只读（D-39）。
 *   - 负责人本人、隔级经理、虚线上级往前推：拦下；直属上级、老板：成，记的是推的人
 *   - 往后退、点结局照旧（负责人本人也能）
 *   - 一个人既是直属又是虚线：按直属算，能推
 *   - 负责人没设直属上级（组织还没配）：和原来一样，本人也能推
 *   - 不是企业版：组织表配着也不拦
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/sync/client", () => ({ 读团队: () => null }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 改节点, 往前推不给 } from "@/lib/project/db";
import { invalidateSettingsCache } from "@/lib/settings";

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
    expect(await 改节点(组长, p.id, 往前)).toMatchObject({ ok: true });
    expect(await prisma.projectNodeLog.findFirstOrThrow({ where: { projectId: p.id, toNode: "线索验证" } })).toMatchObject({ userId: 组长.id });
    expect(await 改节点(老板, p.id, { phase: "线索", node: "线索推进" })).toMatchObject({ ok: true });
  });

  it("往后退、点结局照旧：本人也能", async () => {
    const p = await 项目(销售.id, { node: "线索推进" });
    expect(await 改节点(销售, p.id, 往前)).toMatchObject({ ok: true });
    expect(await 改节点(销售, p.id, { ...往前, result: "线索流失" })).toMatchObject({ ok: true });
  });

  it("既是直属又是虚线：按直属算", async () => {
    await prisma.entMember.update({ where: { userId: 销售.id }, data: { dottedManagerId: 组长.id } });
    const p = await 项目(销售.id);
    expect(await 改节点(组长, p.id, 往前)).toMatchObject({ ok: true });
  });

  it("负责人没设直属上级：照旧，本人能推", async () => {
    const p = await 项目(散.id);
    expect(await 改节点(散, p.id, 往前)).toMatchObject({ ok: true });
  });

  it("不是企业版：组织配着也不拦", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    const p = await 项目(销售.id);
    expect(await 改节点(销售, p.id, 往前)).toMatchObject({ ok: true });
    expect(往前推不给(销售, 销售.id, null)).toBeNull();
  });
});
