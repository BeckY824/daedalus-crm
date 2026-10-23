/**
 * 团队版项目模式 1a 的读写（lib/project/db.ts）+ 业务员看得到哪些项目（lib/team-scope.ts）。
 * 钉的是总控 10-23 的「最简规则」：每改一次节点留一行、成功交付两项都勾才让点、异常必须有原因、
 * 恢复 = 再改节点；组员角色字典只有老板能改、停用不删；项目跟客户走，负责人自己的也看得到。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 改节点, 勾交付, 角色字典, 加角色, 改角色, 默认角色们, 客户的项目数, 能管项目 } from "@/lib/project/db";
import { 限定条件 } from "@/lib/team-scope";

let 老板: { id: string; role: string };
let 乙: { id: string; role: string };
let 丙: { id: string; role: string };
let 客户甲: string;

async function 人(email: string, role: string) {
  const u = await prisma.user.create({ data: { email, name: email, title: "", role, password: "x" } });
  return { id: u.id, role };
}

async function 项目(ownerId: string, customerId = 客户甲, 补: Record<string, unknown> = {}) {
  return prisma.project.create({ data: { name: "一号项目", customerId, ownerId, creatorId: ownerId, ...补 } });
}

beforeEach(async () => {
  await resetDb();
  老板 = await 人("boss", "ADMIN");
  乙 = await 人("yi", "SALES");
  丙 = await 人("bing", "SALES");
  客户甲 = (await prisma.customer.create({ data: { name: "客户甲", phone: "13800000001", salesOwnerId: 老板.id } })).id;
});

describe("改节点", () => {
  it("前后随意改，每改一次记一行；没变的不记", async () => {
    const p = await 项目(乙.id);
    expect(await 改节点(乙, p.id, { phase: "商机", node: "签约审批" })).toEqual({ ok: true, 变了: true });
    expect(await 改节点(乙, p.id, { phase: "线索", node: "线索验证" })).toEqual({ ok: true, 变了: true });
    expect(await 改节点(乙, p.id, { phase: "线索", node: "线索验证" })).toEqual({ ok: true, 变了: false });
    const logs = await prisma.projectNodeLog.findMany({ where: { projectId: p.id }, orderBy: { at: "asc" } });
    expect(logs.map((l) => [l.fromNode, l.toNode, l.userId])).toEqual([
      ["潜客培育", "签约审批", 乙.id],
      ["签约审批", "线索验证", 乙.id],
    ]);
  });

  it("只有负责人、老板、主管能改；同事改不了", async () => {
    const p = await 项目(乙.id);
    expect(await 改节点(丙, p.id, { phase: "商机", node: "明确需求" })).toMatchObject({ ok: false, error: expect.stringContaining("项目负责人") });
    expect(await 改节点(老板, p.id, { phase: "商机", node: "明确需求" })).toMatchObject({ ok: true });
    expect(能管项目({ id: "x", role: "MANAGER" }, { ownerId: 乙.id })).toBe(true);
    expect(await prisma.projectNodeLog.count()).toBe(1);
  });

  it("异常状态：没原因拦；有原因记在项目和节点变更里；恢复后项目上清掉、变更里还留着", async () => {
    const p = await 项目(乙.id, 客户甲, { phase: "订单", node: "安装实施" });
    expect(await 改节点(乙, p.id, { phase: "订单", node: "安装实施", result: "异常状态" }, "  ")).toMatchObject({ ok: false });
    expect(await 改节点(乙, p.id, { phase: "订单", node: "安装实施", result: "异常状态" }, " 现场电压不对 ")).toMatchObject({ ok: true });
    let 现在 = await prisma.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(现在).toMatchObject({ result: "异常状态", exceptionReason: "现场电压不对" });
    expect(现在.closedAt).not.toBeNull();

    expect(await 改节点(乙, p.id, { phase: "订单", node: "安装实施" })).toMatchObject({ ok: true, 变了: true });
    现在 = await prisma.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(现在).toMatchObject({ result: null, exceptionReason: null, closedAt: null });
    const logs = await prisma.projectNodeLog.findMany({ where: { projectId: p.id }, orderBy: { at: "asc" } });
    expect(logs.map((l) => [l.toResult, l.reason])).toEqual([["异常状态", "现场电压不对"], [null, null]]);
  });

  it("异常原因改了也算一次变更；同一结局 closedAt 不跟着刷新", async () => {
    const p = await 项目(乙.id, 客户甲, { phase: "订单", node: "安装实施" });
    await 改节点(乙, p.id, { phase: "订单", node: "安装实施", result: "异常状态" }, "原因一");
    const 第一次 = (await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).closedAt;
    expect(await 改节点(乙, p.id, { phase: "订单", node: "安装实施", result: "异常状态" }, "原因二")).toEqual({ ok: true, 变了: true });
    const 现在 = await prisma.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(现在.exceptionReason).toBe("原因二");
    expect(现在.closedAt).toEqual(第一次);
  });

  it("成功交付：两项没勾齐拦；勾齐了能点；成功交付后不让取消勾，先改回节点", async () => {
    const p = await 项目(乙.id, 客户甲, { phase: "订单", node: "尾款结算" });
    const 到 = { phase: "订单", node: "尾款结算", result: "成功交付" };
    expect(await 改节点(乙, p.id, 到)).toMatchObject({ ok: false, error: expect.stringContaining("尾款结清、验收通过") });
    expect(await 勾交付(乙, p.id, "balanceSettled", true)).toEqual({ ok: true, 变了: true });
    expect(await 改节点(乙, p.id, 到)).toMatchObject({ ok: false, error: expect.stringContaining("还差验收通过") });
    await 勾交付(乙, p.id, "acceptancePassed", true);
    expect(await 改节点(乙, p.id, 到)).toMatchObject({ ok: true });

    expect(await 勾交付(乙, p.id, "acceptancePassed", false)).toMatchObject({ ok: false, error: expect.stringContaining("先把节点改回去") });
    await 改节点(乙, p.id, { phase: "订单", node: "尾款结算" });
    expect(await 勾交付(乙, p.id, "acceptancePassed", false)).toEqual({ ok: true, 变了: true });
    const 现在 = await prisma.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(现在).toMatchObject({ balanceSettled: true, balanceSettledById: 乙.id, acceptancePassed: false, acceptancePassedById: null, acceptancePassedAt: null });
  });

  it("项目不在了、同事来勾：说人话，不抛", async () => {
    const p = await 项目(乙.id);
    expect(await 改节点(乙, "没有这个", { phase: "线索", node: "线索验证" })).toMatchObject({ ok: false, error: expect.stringContaining("不在了") });
    expect(await 勾交付(丙, p.id, "balanceSettled", true)).toMatchObject({ ok: false });
    expect(await 勾交付(乙, p.id, "随便" as never, true)).toMatchObject({ ok: false });
  });
});

describe("组员角色字典", () => {
  it("第一次读补上默认 4 个，再读不重复", async () => {
    expect((await 角色字典()).map((r) => r.name)).toEqual([...默认角色们]);
    expect((await 角色字典()).length).toBe(4);
  });

  it("只有老板能加、能改；业务员、主管都不行", async () => {
    await 角色字典();
    expect(await 加角色(乙, "质检")).toMatchObject({ ok: false });
    expect(await 加角色({ id: "m", role: "MANAGER" }, "质检")).toMatchObject({ ok: false });
    const r = await 加角色(老板, " 质检 ");
    expect(r).toMatchObject({ ok: true });
    expect((await 角色字典()).at(-1)).toMatchObject({ name: "质检", sort: 4 });
    expect(await 改角色(乙, r.id!, { name: "品控" })).toMatchObject({ ok: false });
  });

  it("名字空着、太长、重名都拦", async () => {
    await 角色字典();
    expect(await 加角色(老板, "  ")).toMatchObject({ ok: false });
    expect(await 加角色(老板, "长".repeat(21))).toMatchObject({ ok: false });
    expect(await 加角色(老板, "售后")).toMatchObject({ ok: false, error: expect.stringContaining("已经有") });
    const 售后 = (await 角色字典()).find((r) => r.name === "售后")!;
    const 项目经理 = (await 角色字典()).find((r) => r.name === "项目经理")!;
    expect(await 改角色(老板, 售后.id, { name: "项目经理" })).toMatchObject({ ok: false });
    expect(await 改角色(老板, 项目经理.id, { name: "项目经理" })).toMatchObject({ ok: true });
  });

  it("停用不删：用它的组员还认得；同名再加 = 重新启用", async () => {
    const 售后 = (await 角色字典()).find((r) => r.name === "售后")!;
    const p = await 项目(乙.id);
    await prisma.projectMember.create({ data: { projectId: p.id, userId: 丙.id, roleId: 售后.id } });
    expect(await 改角色(老板, 售后.id, { active: false })).toEqual({ ok: true });
    const m = await prisma.projectMember.findFirstOrThrow({ include: { role: true } });
    expect(m.role).toMatchObject({ name: "售后", active: false });
    expect(await 加角色(老板, "售后")).toEqual({ ok: true, id: 售后.id });
    expect((await 角色字典()).filter((r) => r.name === "售后")).toMatchObject([{ active: true }]);
  });
});

describe("客户的项目数", () => {
  it("按客户数，没项目的不出现", async () => {
    const 客户乙 = (await prisma.customer.create({ data: { name: "客户乙", phone: "13800000002", salesOwnerId: 乙.id } })).id;
    await 项目(乙.id);
    await 项目(老板.id);
    const n = await 客户的项目数([客户甲, 客户乙]);
    expect(n.get(客户甲)).toBe(2);
    expect(n.has(客户乙)).toBe(false);
    expect((await 客户的项目数([])).size).toBe(0);
  });
});

describe("业务员看得到哪些项目（团队范围）", () => {
  it("自己客户下的、自己负责的看得到；同事客户下同事负责的看不到；组员、节点变更跟着项目走", async () => {
    const 客户乙 = (await prisma.customer.create({ data: { name: "客户乙", phone: "13800000002", salesOwnerId: 乙.id } })).id;
    const 自己客户 = await 项目(老板.id, 客户乙);
    const 自己负责 = await 项目(乙.id, 客户甲);
    const 看不到 = await 项目(老板.id, 客户甲);
    for (const p of [自己客户, 自己负责, 看不到]) {
      await prisma.projectNodeLog.create({ data: { projectId: p.id, userId: 老板.id, toPhase: "线索", toNode: "潜客培育" } });
    }
    const ids = async (model: "project" | "projectNodeLog") => {
      const where = 限定条件(model === "project" ? "Project" : "ProjectNodeLog", 乙.id) as never;
      const rows = model === "project"
        ? (await prisma.project.findMany({ where })).map((r) => r.id)
        : (await prisma.projectNodeLog.findMany({ where })).map((r) => r.projectId);
      return rows.sort();
    };
    const 应该 = [自己客户.id, 自己负责.id].sort();
    expect(await ids("project")).toEqual(应该);
    expect(await ids("projectNodeLog")).toEqual(应该);
    expect(限定条件("ProjectMember", 乙.id)).toMatchObject({ project: { OR: expect.any(Array) } });
    expect(限定条件("FollowUpProject", 乙.id)).toMatchObject({ project: { OR: expect.any(Array) } });
  });
});
