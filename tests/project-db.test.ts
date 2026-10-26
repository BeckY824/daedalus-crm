/**
 * 团队版项目模式 1a 的读写（lib/project/db.ts）+ 业务员看得到哪些项目（lib/team-scope.ts）。
 * 钉的是总控 10-23 的规则：每改一次节点留一行、往前只能一步、成功交付两项都勾才让点、异常要选类别（备注可空）、
 * 恢复 = 再改节点；组员角色、异常类别字典只有老板能改、停用不删；项目跟客户走，负责人自己的也看得到；
 * 项目公海（线索 / 商机阶段负责人放回、谁都能领、都留痕；企业版里放回的人也能领回、有持有上限，
 * 不是企业版（CRM_ENTERPRISE 不设）时 Setting 里开着也不生效、放回的人不能自己领回）；建档人谁都改不了。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import {
  改节点, 勾交付, 角色字典, 加角色, 改角色, 默认角色们, 客户的项目数, 能管项目, 改项目, 加组员, 换组员角色, 移出组员,
  异常类别字典, 加异常类别, 改异常类别, 默认异常类别们, 放回公海, 领取公海项目, 公海超时收回, 持有数,
  回邀请, 待我回的邀请, 记项目沟通,
} from "@/lib/project/db";
import { setSetting, invalidateSettingsCache } from "@/lib/settings";
import { 限定条件 } from "@/lib/team-scope";
import { dayjs } from "@/lib/utils";

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
  invalidateSettingsCache();
  老板 = await 人("boss", "ADMIN");
  乙 = await 人("yi", "SALES");
  丙 = await 人("bing", "SALES");
  客户甲 = (await prisma.customer.create({ data: { name: "客户甲", phone: "13800000001", salesOwnerId: 老板.id } })).id;
});

describe("改节点", () => {
  it("往前一步一步走、往后随便退，每改一次记一行；没变的不记；往前跳拦下不记", async () => {
    const p = await 项目(乙.id);
    expect(await 改节点(乙, p.id, { phase: "商机", node: "签约审批" })).toMatchObject({ ok: false, error: expect.stringContaining("只能先推到「线索验证」") });
    expect(await 改节点(乙, p.id, { phase: "线索", node: "线索验证" })).toEqual({ ok: true, 变了: true });
    expect(await 改节点(乙, p.id, { phase: "线索", node: "线索推进" })).toEqual({ ok: true, 变了: true });
    expect(await 改节点(乙, p.id, { phase: "商机", node: "明确需求" })).toEqual({ ok: true, 变了: true });
    expect(await 改节点(乙, p.id, { phase: "线索", node: "潜客培育" })).toEqual({ ok: true, 变了: true });
    expect(await 改节点(乙, p.id, { phase: "线索", node: "潜客培育" })).toEqual({ ok: true, 变了: false });
    const logs = await prisma.projectNodeLog.findMany({ where: { projectId: p.id }, orderBy: { at: "asc" } });
    expect(logs.map((l) => [l.kind, l.fromNode, l.toNode, l.userId])).toEqual([
      ["node", "潜客培育", "线索验证", 乙.id],
      ["node", "线索验证", "线索推进", 乙.id],
      ["node", "线索推进", "明确需求", 乙.id],
      ["node", "明确需求", "潜客培育", 乙.id],
    ]);
  });

  it("老板也不能往前跳", async () => {
    const p = await 项目(乙.id, 客户甲, { phase: "订单", node: "合同签订" });
    expect(await 改节点(老板, p.id, { phase: "订单", node: "尾款结算" })).toMatchObject({ ok: false, error: expect.stringContaining("节点不能往前跳") });
    expect(await prisma.projectNodeLog.count()).toBe(0);
  });

  it("只有负责人、老板、主管能改；同事改不了", async () => {
    const p = await 项目(乙.id);
    expect(await 改节点(丙, p.id, { phase: "线索", node: "线索验证" })).toMatchObject({ ok: false, error: expect.stringContaining("项目负责人") });
    expect(await 改节点(老板, p.id, { phase: "线索", node: "线索验证" })).toMatchObject({ ok: true });
    expect(能管项目({ id: "x", role: "MANAGER" }, { ownerId: 乙.id })).toBe(true);
    expect(await prisma.projectNodeLog.count()).toBe(1);
  });

  it("异常状态：没类别拦；类别 + 备注记在项目和节点变更里；恢复后项目上清掉、变更里还留着", async () => {
    await 异常类别字典();
    const p = await 项目(乙.id, 客户甲, { phase: "订单", node: "安装实施" });
    const 异常 = { phase: "订单", node: "安装实施", result: "异常状态" };
    expect(await 改节点(乙, p.id, 异常, { 备注: "现场电压不对" })).toMatchObject({ ok: false, error: expect.stringContaining("异常类别") });
    expect(await 改节点(乙, p.id, 异常, { categoryId: "没这个" })).toMatchObject({ ok: false, error: expect.stringContaining("不在了") });
    expect(await 改节点(乙, p.id, 异常, { categoryId: "dispute-cancel", 备注: " 现场电压不对 " })).toMatchObject({ ok: true });
    let 现在 = await prisma.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(现在).toMatchObject({ result: "异常状态", exceptionCategoryId: "dispute-cancel", exceptionReason: "现场电压不对" });
    expect(现在.closedAt).not.toBeNull();

    expect(await 改节点(乙, p.id, { phase: "订单", node: "安装实施" })).toMatchObject({ ok: true, 变了: true });
    现在 = await prisma.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(现在).toMatchObject({ result: null, exceptionCategoryId: null, exceptionReason: null, closedAt: null });
    const logs = await prisma.projectNodeLog.findMany({ where: { projectId: p.id }, orderBy: { at: "asc" } });
    expect(logs.map((l) => [l.toResult, l.categoryId, l.reason])).toEqual([["异常状态", "dispute-cancel", "现场电压不对"], [null, null, null]]);
  });

  it("备注可以不写；类别、备注改了都算一次变更；同一结局 closedAt 不跟着刷新", async () => {
    await 异常类别字典();
    const p = await 项目(乙.id, 客户甲, { phase: "订单", node: "安装实施" });
    const 异常 = { phase: "订单", node: "安装实施", result: "异常状态" };
    expect(await 改节点(乙, p.id, 异常, { categoryId: "stalled" })).toEqual({ ok: true, 变了: true });
    const 第一次 = await prisma.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(第一次.exceptionReason).toBeNull();
    expect(await 改节点(乙, p.id, 异常, { categoryId: "stalled", 备注: "  " })).toEqual({ ok: true, 变了: false });
    expect(await 改节点(乙, p.id, 异常, { categoryId: "stalled", 备注: "客户不回" })).toEqual({ ok: true, 变了: true });
    expect(await 改节点(乙, p.id, 异常, { categoryId: "dispute-cancel", 备注: "客户不回" })).toEqual({ ok: true, 变了: true });
    const 现在 = await prisma.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(现在).toMatchObject({ exceptionCategoryId: "dispute-cancel", exceptionReason: "客户不回" });
    expect(现在.closedAt).toEqual(第一次.closedAt);
  });

  it("停用的类别不能新选；已经用着的留着、只改备注也行", async () => {
    await 异常类别字典();
    const p = await 项目(乙.id, 客户甲, { phase: "订单", node: "安装实施" });
    const 异常 = { phase: "订单", node: "安装实施", result: "异常状态" };
    await 改节点(乙, p.id, 异常, { categoryId: "stalled" });
    await 改异常类别(老板, "stalled", { active: false });
    expect(await 改节点(乙, p.id, 异常, { categoryId: "stalled", 备注: "还在等" })).toEqual({ ok: true, 变了: true });
    await 改节点(乙, p.id, { phase: "订单", node: "安装实施" });
    expect(await 改节点(乙, p.id, 异常, { categoryId: "stalled" })).toMatchObject({ ok: false, error: expect.stringContaining("停用") });
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

  it("企业版线索流失、丢单：没写原因拦下不记；写了原因记进节点变更，项目上的异常备注不沾（F8）", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "1");
    const p = await 项目(乙.id, 客户甲, { phase: "线索", node: "线索推进" });
    const 流失 = { phase: "线索", node: "线索推进", result: "线索流失" };
    expect(await 改节点(乙, p.id, 流失)).toMatchObject({ ok: false, error: "点「线索流失」要写一句原因" });
    expect(await 改节点(乙, p.id, 流失, { 备注: "  " })).toMatchObject({ ok: false, error: "点「线索流失」要写一句原因" });
    expect(await prisma.projectNodeLog.count({ where: { projectId: p.id } })).toBe(0);
    expect(await 改节点(乙, p.id, 流失, { 备注: " 预算砍了 " })).toEqual({ ok: true, 变了: true });
    const 现在 = await prisma.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(现在).toMatchObject({ result: "线索流失", exceptionCategoryId: null, exceptionReason: null });
    expect(现在.closedAt).not.toBeNull();
    const q = await 项目(乙.id, 客户甲, { phase: "商机", node: "签约审批" });
    expect(await 改节点(乙, q.id, { phase: "商机", node: "签约审批", result: "丢单" }, { 备注: "被对手压价" })).toEqual({ ok: true, 变了: true });
    const logs = await prisma.projectNodeLog.findMany({ where: { projectId: { in: [p.id, q.id] } } });
    expect(logs).toHaveLength(2);
    expect(logs.map((l) => [l.toResult, l.reason, l.categoryId])).toEqual(expect.arrayContaining([["线索流失", "预算砍了", null], ["丢单", "被对手压价", null]]));
    vi.unstubAllEnvs();
  });

  it("不是企业版：线索流失不写原因照旧能点，节点变更 reason 留空（F8 开关关和 main 一样）", async () => {
    const p = await 项目(乙.id, 客户甲, { phase: "线索", node: "线索推进" });
    expect(await 改节点(乙, p.id, { phase: "线索", node: "线索推进", result: "线索流失" })).toEqual({ ok: true, 变了: true });
    expect((await prisma.projectNodeLog.findFirstOrThrow({ where: { projectId: p.id } })).reason).toBeNull();
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

describe("异常类别字典", () => {
  it("第一次读补上默认 2 个（固定 id），再读不重复", async () => {
    expect((await 异常类别字典()).map((r) => [r.id, r.name])).toEqual([["dispute-cancel", 默认异常类别们[0]], ["stalled", 默认异常类别们[1]]]);
    expect((await 异常类别字典()).length).toBe(2);
  });

  it("只有老板能加、能改；名字空、太长、重名拦", async () => {
    await 异常类别字典();
    expect(await 加异常类别(乙, "延期")).toMatchObject({ ok: false });
    expect(await 加异常类别({ id: "m", role: "MANAGER" }, "延期")).toMatchObject({ ok: false });
    expect(await 加异常类别(老板, " ")).toMatchObject({ ok: false });
    expect(await 加异常类别(老板, "长".repeat(21))).toMatchObject({ ok: false });
    expect(await 加异常类别(老板, "项目停滞")).toMatchObject({ ok: false, error: expect.stringContaining("已经有") });
    const r = await 加异常类别(老板, " 延期 ");
    expect(r).toMatchObject({ ok: true });
    expect((await 异常类别字典()).at(-1)).toMatchObject({ name: "延期", sort: 2 });
    expect(await 改异常类别(乙, r.id!, { name: "延误" })).toMatchObject({ ok: false });
    expect(await 改异常类别(老板, r.id!, { name: "纠纷取消" })).toMatchObject({ ok: false });
    expect(await 改异常类别(老板, r.id!, { name: "延误" })).toEqual({ ok: true });
  });

  it("停用不删：用它的项目还认得；同名再加 = 重新启用", async () => {
    await 异常类别字典();
    const p = await 项目(乙.id, 客户甲, { phase: "订单", node: "安装实施" });
    await 改节点(乙, p.id, { phase: "订单", node: "安装实施", result: "异常状态" }, { categoryId: "dispute-cancel" });
    expect(await 改异常类别(老板, "dispute-cancel", { active: false })).toEqual({ ok: true });
    const 现在 = await prisma.project.findUniqueOrThrow({ where: { id: p.id }, include: { exceptionCategory: true } });
    expect(现在.exceptionCategory).toMatchObject({ name: "纠纷取消", active: false });
    expect(await 加异常类别(老板, "纠纷取消")).toEqual({ ok: true, id: "dispute-cancel" });
    expect((await 异常类别字典()).filter((r) => r.active).length).toBe(2);
  });
});

describe("项目公海", () => {
  // 下面默认按企业版跑；「不是企业版」那条自己关掉
  beforeEach(() => { vi.stubEnv("CRM_ENTERPRISE", "1"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("负责人在线索 / 商机阶段能放回；订单阶段、别人、已在公海都拦", async () => {
    const 线索 = await 项目(乙.id);
    const 商机 = await 项目(乙.id, 客户甲, { phase: "商机", node: "签约审批" });
    const 订单 = await 项目(乙.id, 客户甲, { phase: "订单", node: "合同签订" });
    expect(await 放回公海(丙, 线索.id)).toMatchObject({ ok: false, error: expect.stringContaining("只有项目负责人") });
    expect(await 放回公海(老板, 线索.id)).toMatchObject({ ok: false, error: expect.stringContaining("只有项目负责人") });
    expect(await 放回公海(乙, 订单.id)).toMatchObject({ ok: false, error: expect.stringContaining("订单阶段") });
    expect(await 放回公海(乙, 线索.id)).toEqual({ ok: true });
    expect(await 放回公海(乙, 商机.id)).toEqual({ ok: true });
    expect(await 放回公海(乙, 线索.id)).toMatchObject({ ok: false, error: expect.stringContaining("已经在公海") });
    const 现在 = await prisma.project.findUniqueOrThrow({ where: { id: 线索.id } });
    expect(现在.pooledAt).not.toBeNull();
    expect(现在.ownerId).toBe(乙.id);
    const log = await prisma.projectNodeLog.findFirstOrThrow({ where: { projectId: 线索.id } });
    expect(log).toMatchObject({ kind: "pool-release", userId: 乙.id, fromOwnerId: 乙.id, toOwnerId: null, toNode: "潜客培育" });
  });

  it("放回去的人在公海里改不了，但能自己领回；别人领了就是新负责人，留痕；领走后别人再领拦", async () => {
    const p = await 项目(乙.id);
    await 放回公海(乙, p.id);
    expect(await 改节点(乙, p.id, { phase: "线索", node: "线索验证" })).toMatchObject({ ok: false, error: expect.stringContaining("公海") });
    expect(await 改项目(乙, p.id, { name: "改个名" })).toMatchObject({ ok: false, error: expect.stringContaining("公海") });
    expect(await 领取公海项目(乙, p.id)).toEqual({ ok: true });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ ownerId: 乙.id, pooledAt: null });
    await 放回公海(乙, p.id);
    expect(await 领取公海项目(丙, p.id)).toEqual({ ok: true });
    expect(await 领取公海项目(老板, p.id)).toMatchObject({ ok: false, error: expect.stringContaining("领走") });
    expect(await 领取公海项目(乙, p.id)).toMatchObject({ ok: false, error: expect.stringContaining("领走") });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ ownerId: 丙.id, pooledAt: null });
    const logs = await prisma.projectNodeLog.findMany({ where: { projectId: p.id }, orderBy: { at: "asc" } });
    expect(logs.map((l) => [l.kind, l.userId, l.fromOwnerId, l.toOwnerId])).toEqual([
      ["pool-release", 乙.id, 乙.id, null],
      ["pool-claim", 乙.id, 乙.id, 乙.id],
      ["pool-release", 乙.id, 乙.id, null],
      ["pool-claim", 丙.id, 乙.id, 丙.id],
    ]);
    expect(await 改节点(丙, p.id, { phase: "线索", node: "线索验证" })).toMatchObject({ ok: true });
  });

  it("停用的账号领不了；老板指了新负责人 = 出公海", async () => {
    const p = await 项目(乙.id);
    await 放回公海(乙, p.id);
    const 丁 = await 人("ding", "SALES");
    await prisma.user.update({ where: { id: 丁.id }, data: { active: false } });
    expect(await 领取公海项目(丁, p.id)).toMatchObject({ ok: false });
    expect(await 改项目(老板, p.id, { name: "一号项目", ownerId: 丙.id })).toMatchObject({ ok: true });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ ownerId: 丙.id, pooledAt: null });
  });

  it("公海里的项目所有业务员都看得到", async () => {
    const 看不到 = await 项目(老板.id);
    const 公海里 = await 项目(老板.id, 客户甲, { pooledAt: new Date() });
    const ids = (await prisma.project.findMany({ where: 限定条件("Project", 乙.id) as never })).map((r) => r.id);
    expect(ids).toContain(公海里.id);
    expect(ids).not.toContain(看不到.id);
  });

  it("持有上限关着（默认）：手上再多也能领、能被指派", async () => {
    for (let i = 0; i < 3; i++) await 项目(丙.id);
    const p = await 项目(乙.id);
    await 放回公海(乙, p.id);
    expect(await 领取公海项目(丙, p.id)).toEqual({ ok: true });
  });

  it("持有上限开着：到了上限领不了、也不能被指派；只算线索 / 商机阶段还在跟、不在公海的", async () => {
    await setSetting("orgRules", { 公海: { 持有上限开: true, 默认上限: 2 } });
    await 项目(丙.id);
    await 项目(丙.id, 客户甲, { phase: "订单", node: "合同签订" });
    await 项目(丙.id, 客户甲, { result: "异常状态" });
    await 项目(丙.id, 客户甲, { pooledAt: new Date() });
    const a = await 项目(乙.id);
    const b = await 项目(乙.id);
    await 放回公海(乙, a.id);
    await 放回公海(乙, b.id);
    expect(await 持有数(prisma, 丙.id)).toBe(1);
    expect(await 领取公海项目(丙, a.id)).toEqual({ ok: true });
    expect(await 领取公海项目(丙, b.id)).toMatchObject({ ok: false, error: expect.stringContaining("持有上限（2 个）") });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ ownerId: 乙.id });
    expect(await prisma.projectNodeLog.count({ where: { projectId: b.id, kind: "pool-claim" } })).toBe(0);
    const c = await 项目(老板.id);
    expect(await 改项目(老板, c.id, { name: "一号项目", ownerId: 丙.id })).toMatchObject({ ok: false, error: expect.stringContaining("持有上限") });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: c.id } })).ownerId).toBe(老板.id);
    // 订单阶段的项目换给他不占名额，照样能指
    const d = await 项目(老板.id, 客户甲, { phase: "订单", node: "合同签订" });
    expect(await 改项目(老板, d.id, { name: "一号项目", ownerId: 丙.id })).toMatchObject({ ok: true });
    // 不换人只改名不拦
    expect(await 改项目(丙, a.id, { name: "改个名" })).toMatchObject({ ok: true });
  });

  it("不是企业版：Setting 里持有上限开着也不拦领取和指派；放回的人不能自己领回（原来的规矩）", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    await setSetting("orgRules", { 公海: { 持有上限开: true, 默认上限: 1, 每人上限: { [丙.id]: 0 } } });
    await 项目(丙.id);
    const a = await 项目(乙.id);
    await 放回公海(乙, a.id);
    expect(await 持有数(prisma, 丙.id)).toBe(1);
    expect(await 领取公海项目(乙, a.id)).toMatchObject({ ok: false, error: "自己放回公海的项目不能自己领回" });
    expect(await 领取公海项目(丙, a.id)).toEqual({ ok: true });
    const c = await 项目(老板.id);
    expect(await 改项目(老板, c.id, { name: "一号项目", ownerId: 丙.id })).toMatchObject({ ok: true });
    expect(await prisma.project.count({ where: { ownerId: 丙.id, pooledAt: null } })).toBe(3);
  });

  it("持有上限按人单独设：0 = 一个都不能再拿；没单独设的用默认", async () => {
    await setSetting("orgRules", { 公海: { 持有上限开: true, 默认上限: 5, 每人上限: { [丙.id]: 0 } } });
    const p = await 项目(乙.id);
    await 放回公海(乙, p.id);
    expect(await 领取公海项目(丙, p.id)).toMatchObject({ ok: false, error: expect.stringContaining("持有上限（0 个）") });
    expect(await 领取公海项目(老板, p.id)).toEqual({ ok: true });
  });

  it("超时回收没开：调了什么都不做（开了的见 project-timeout.test.ts）", async () => {
    await 项目(乙.id);
    expect(await 公海超时收回({ id: 老板.id, name: "boss" }, new Date(Date.now() + 400 * 86400_000))).toBe(0);
    expect(await prisma.project.count({ where: { pooledAt: { not: null } } })).toBe(0);
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

describe("编辑项目", () => {
  it("改名称、金额、币种、备注、负责人；返回改了哪几样；没变不写", async () => {
    const p = await 项目(乙.id);
    expect(await 改项目(乙, p.id, { name: " 二期 ", amount: 5000, currency: "USD", remark: " 加急 ", ownerId: 丙.id })).toEqual({
      ok: true, 变了: ["name", "ownerId", "amount", "currency", "remark"],
    });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ name: "二期", ownerId: 丙.id, amount: 5000, currency: "USD", remark: "加急" });
    expect(await 改项目(丙, p.id, { name: "二期", amount: 5000, currency: "USD", remark: "加急" })).toEqual({ ok: true, 变了: [] });
  });

  it("建档人谁都改不了：老板带着 creatorId 来改也不动", async () => {
    const p = await 项目(乙.id);
    expect(await 改项目(老板, p.id, { name: "一号项目", creatorId: 丙.id } as never)).toEqual({ ok: true, 变了: [] });
    expect(await 改项目(乙, p.id, { name: "二号", creatorId: 老板.id } as never)).toEqual({ ok: true, 变了: ["name"] });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).creatorId).toBe(乙.id);
  });

  it("换负责人 = 转让，记一行 transfer", async () => {
    const p = await 项目(乙.id);
    await 改项目(乙, p.id, { name: "一号项目", ownerId: 丙.id });
    expect(await prisma.projectNodeLog.findFirstOrThrow()).toMatchObject({ kind: "transfer", userId: 乙.id, fromOwnerId: 乙.id, toOwnerId: 丙.id });
  });

  it("同事改不了；名称空、金额负数照向导第四步拦", async () => {
    const p = await 项目(乙.id);
    expect(await 改项目(丙, p.id, { name: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("项目负责人") });
    expect(await 改项目(乙, p.id, { name: " " })).toMatchObject({ ok: false, error: expect.stringContaining("项目名称") });
    expect(await 改项目(乙, p.id, { name: "x", amount: -1 })).toMatchObject({ ok: false, error: expect.stringContaining("负数") });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).name).toBe("一号项目");
  });

  it("新负责人停用了拦；原负责人停用了改别的照样能存", async () => {
    const p = await 项目(乙.id);
    await prisma.user.update({ where: { id: 丙.id }, data: { active: false } });
    expect(await 改项目(老板, p.id, { name: "一号项目", ownerId: 丙.id })).toMatchObject({ ok: false, error: expect.stringContaining("在职") });
    await prisma.user.update({ where: { id: 乙.id }, data: { active: false } });
    expect(await 改项目(老板, p.id, { name: "新名字" })).toEqual({ ok: true, 变了: ["name"] });
  });

  it("主联系人只能是这位客户的；清空也行", async () => {
    const p = await 项目(乙.id);
    const 本家 = await prisma.contact.create({ data: { customerId: 客户甲, name: "王" } });
    const 别家客户 = await prisma.customer.create({ data: { name: "客户乙", phone: "13800000002", salesOwnerId: 老板.id } });
    const 别家 = await prisma.contact.create({ data: { customerId: 别家客户.id, name: "李" } });
    expect(await 改项目(乙, p.id, { name: "一号项目", contactId: 别家.id })).toMatchObject({ ok: false, error: expect.stringContaining("联系人") });
    expect(await 改项目(乙, p.id, { name: "一号项目", contactId: 本家.id })).toEqual({ ok: true, 变了: ["contactId"] });
    expect(await 改项目(乙, p.id, { name: "一号项目", contactId: null })).toEqual({ ok: true, 变了: ["contactId"] });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).contactId).toBeNull();
  });
});

describe("项目组", () => {
  it("加人直接进组（JOINED，记谁拉的）；重复加拦；停用的人加不进", async () => {
    const p = await 项目(乙.id);
    const [r] = await 角色字典();
    expect(await 加组员(乙, p.id, 丙.id, r.id)).toEqual({ ok: true });
    expect(await prisma.projectMember.findFirstOrThrow({ where: { projectId: p.id } })).toMatchObject({ userId: 丙.id, roleId: r.id, inviteStatus: "JOINED", invitedById: 乙.id });
    expect(await 加组员(乙, p.id, 丙.id)).toMatchObject({ ok: false, error: expect.stringContaining("已经在") });
    const 丁 = await 人("ding", "SALES");
    await prisma.user.update({ where: { id: 丁.id }, data: { active: false } });
    expect(await 加组员(乙, p.id, 丁.id)).toMatchObject({ ok: false, error: expect.stringContaining("停用") });
  });

  it("同事加不了人、换不了角色、移不了人", async () => {
    const p = await 项目(乙.id);
    await 加组员(乙, p.id, 老板.id);
    const m = await prisma.projectMember.findFirstOrThrow();
    expect(await 加组员(丙, p.id, 丙.id)).toMatchObject({ ok: false });
    expect(await 换组员角色(丙, m.id, null)).toMatchObject({ ok: false });
    expect(await 移出组员(丙, m.id)).toMatchObject({ ok: false });
    expect(await prisma.projectMember.count()).toBe(1);
  });

  it("停用的角色不让新选；已经用着它的组员能换走；移出后再移一次也算成", async () => {
    const p = await 项目(乙.id);
    const [甲角色, 乙角色] = await 角色字典();
    await 加组员(乙, p.id, 丙.id, 甲角色.id);
    const m = await prisma.projectMember.findFirstOrThrow();
    await 改角色(老板, 甲角色.id, { active: false });
    expect(await 加组员(乙, p.id, 老板.id, 甲角色.id)).toMatchObject({ ok: false, error: expect.stringContaining("停用") });
    expect(await 换组员角色(乙, m.id, 甲角色.id)).toEqual({ ok: true });
    expect(await 换组员角色(乙, m.id, 乙角色.id)).toEqual({ ok: true });
    expect((await prisma.projectMember.findUniqueOrThrow({ where: { id: m.id } })).roleId).toBe(乙角色.id);
    expect(await 换组员角色(乙, m.id, 甲角色.id)).toMatchObject({ ok: false });
    expect(await 移出组员(乙, m.id)).toEqual({ ok: true });
    expect(await 移出组员(乙, m.id)).toEqual({ ok: true });
    expect(await prisma.projectMember.count()).toBe(0);
  });
});

describe("企业版项目组：邀请 → 同意 / 拒绝（10-26）", () => {
  beforeEach(() => { vi.stubEnv("CRM_ENTERPRISE", "1"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("加组员 = 发邀请；只有本人能回；同意进组、拒绝记没接受；拒绝过的能再邀；邀请着的不能重复邀", async () => {
    const p = await 项目(乙.id);
    expect(await 加组员(乙, p.id, 丙.id)).toEqual({ ok: true });
    const m = await prisma.projectMember.findFirstOrThrow({ where: { projectId: p.id } });
    expect(m).toMatchObject({ userId: 丙.id, inviteStatus: "INVITED", invitedById: 乙.id });
    expect(await 加组员(乙, p.id, 丙.id)).toMatchObject({ ok: false, error: expect.stringContaining("邀请过") });
    expect((await 待我回的邀请(丙)).map((r) => [r.项目, r.负责人, r.邀请人])).toEqual([["一号项目", "yi", "yi"]]);
    expect(await 待我回的邀请(乙)).toEqual([]);
    // 别人替他点不行
    expect(await 回邀请(乙, m.id, true)).toMatchObject({ ok: false });
    expect(await 回邀请(丙, m.id, false)).toEqual({ ok: true, projectId: p.id });
    expect((await prisma.projectMember.findUniqueOrThrow({ where: { id: m.id } })).inviteStatus).toBe("DECLINED");
    expect(await 回邀请(丙, m.id, true)).toMatchObject({ ok: false, error: expect.stringContaining("拒绝过") });
    expect(await 待我回的邀请(丙)).toEqual([]);
    // 再邀一次，这回同意
    expect(await 加组员(乙, p.id, 丙.id)).toEqual({ ok: true });
    expect((await prisma.projectMember.findUniqueOrThrow({ where: { id: m.id } })).inviteStatus).toBe("INVITED");
    expect(await 回邀请(丙, m.id, true)).toEqual({ ok: true, projectId: p.id });
    expect((await prisma.projectMember.findUniqueOrThrow({ where: { id: m.id } })).inviteStatus).toBe("JOINED");
    expect(await 加组员(乙, p.id, 丙.id)).toMatchObject({ ok: false, error: expect.stringContaining("已经在") });
  });

  it("拉自己直接进组，不用自己点同意", async () => {
    const p = await 项目(乙.id);
    expect(await 加组员(老板, p.id, 老板.id)).toEqual({ ok: true });
    expect((await prisma.projectMember.findFirstOrThrow()).inviteStatus).toBe("JOINED");
  });

  it("同意前看不到项目、记不了沟通；同意后看得到（同事客户下的也行），节点变更、组员、沟通跟着放开", async () => {
    const p = await 项目(老板.id, 客户甲);
    const 看到的 = async () => (await prisma.project.findMany({ where: 限定条件("Project", 丙.id) as never })).map((r) => r.id);
    expect(await 加组员(老板, p.id, 丙.id)).toEqual({ ok: true });
    expect(await 看到的()).toEqual([]);
    expect(await 记项目沟通(丙, p.id, { type: "PHONE", content: "聊了", occurredAt: dayjs().format("YYYY-MM-DD HH:mm") })).toMatchObject({ ok: false });
    const m = await prisma.projectMember.findFirstOrThrow();
    await 回邀请(丙, m.id, true);
    expect(await 看到的()).toEqual([p.id]);
    expect(await prisma.projectMember.count({ where: 限定条件("ProjectMember", 丙.id) as never })).toBe(1);
    expect(await 记项目沟通(丙, p.id, { type: "PHONE", content: "聊了", occurredAt: dayjs().format("YYYY-MM-DD HH:mm") })).toMatchObject({ ok: true });
    expect(await prisma.followUpProject.count({ where: 限定条件("FollowUpProject", 丙.id) as never })).toBe(1);
    // 乙不是组员，照旧看不到
    expect((await prisma.project.findMany({ where: 限定条件("Project", 乙.id) as never }))).toEqual([]);
  });

  it("组员角色默认 6 个：原来 4 个 + 采购、跟单；停用了、改了名的不再补", async () => {
    expect((await 角色字典()).map((r) => r.name)).toEqual([...默认角色们, "采购", "跟单"]);
    await prisma.projectRole.update({ where: { id: "purchase" }, data: { name: "采购部", active: false } });
    expect((await 角色字典()).map((r) => r.name)).toEqual([...默认角色们, "采购部", "跟单"]);
  });
});

describe("开关关着：项目组照团队版（10-26 企业版邀请不影响）", () => {
  it("加人直接进组、组员角色 4 个、待回邀请是空的、组员不加进看得到的范围", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    try {
      expect((await 角色字典()).map((r) => r.name)).toEqual([...默认角色们]);
      const p = await 项目(老板.id, 客户甲);
      expect(await 加组员(老板, p.id, 丙.id)).toEqual({ ok: true });
      expect((await prisma.projectMember.findFirstOrThrow()).inviteStatus).toBe("JOINED");
      expect(await 待我回的邀请(丙)).toEqual([]);
      expect(await prisma.project.findMany({ where: 限定条件("Project", 丙.id) as never })).toEqual([]);
      expect(JSON.stringify(限定条件("Project", 丙.id))).not.toContain("members");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
