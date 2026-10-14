import { beforeEach, afterAll, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: { id: "", name: "QA", email: "qa", role: "ADMIN", title: "管理员" } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => state.user }));
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { setSetting, invalidateSettingsCache } from "@/lib/settings";
import { BUSINESS_PRESETS } from "@/lib/business-config";
import { saveOpportunity, moveStage, setOppStatus } from "@/app/(app)/opportunities/actions";
let customerId: string;
beforeEach(async () => {
  await resetDb(); invalidateSettingsCache();
  state.user.id = (await prisma.user.create({ data: { name: "QA", email: "qa-opp", password: "unused", role: "ADMIN" } })).id;
  customerId = (await prisma.customer.create({ data: { name: "QA客户", phone: "", salesOwnerId: state.user.id } })).id;
});
afterAll(async () => { await prisma.$disconnect(); });
const create = (patch = {}) => prisma.opportunity.create({ data: { name: "QA商机", customerId, ownerId: state.user.id, amount: 100, stage: "方案报价", status: "OPEN", probability: 75, ...patch } });
const input = (patch = {}) => ({ name: "QA商机", customerId, ownerId: state.user.id, amount: 100, stage: "方案报价", status: "OPEN", probability: 75, ...patch });
it.each(["WON", "LOST"])("J-091 编辑保存%s，概率统一为100/0", async (status) => {
  const o = await create();
  expect((await saveOpportunity(input({ id: o.id, status }))).ok).toBe(true);
  expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).probability).toBe(status === "WON" ? 100 : 0);
});
it.each(["WON", "LOST"])("J-091 %s重新打开，不留下赢单阶段/关闭概率", async (status) => {
  const o = await create({ status, stage: status === "WON" ? "赢单成交" : "方案报价", probability: status === "WON" ? 100 : 0, closed: { create: {} } });
  expect((await setOppStatus(o.id, "OPEN")).ok).toBe(true);
  const after = await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id }, include: { closed: true } });
  expect(after.stage).not.toBe("赢单成交"); expect(after.probability).toBeGreaterThan(0); expect(after.probability).toBeLessThan(100); expect(after.closed).toBeNull();
});
it("W-008 外贸三个入口不能无订单标成已转订单", async () => {
  await setSetting("business", BUSINESS_PRESETS["外贸出口"]); invalidateSettingsCache();
  const o = await create();
  for (const call of [() => saveOpportunity(input({ id: o.id, stage: "赢单成交", status: "WON" })), () => moveStage(o.id, "赢单成交"), () => setOppStatus(o.id, "WON")]) {
    expect(await call()).toMatchObject({ ok: false, error: expect.stringContaining("订单") });
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("OPEN");
  }
  expect(await prisma.auditLog.count()).toBe(0);
});
it("W-008 改阶段不能绕过已有订单的回退限制", async () => {
  const o = await create({ status: "WON", stage: "赢单成交", probability: 100 });
  const c = await prisma.contract.create({ data: { customerId, amount: 100, signedAt: new Date() } });
  await prisma.tradeOrder.create({ data: { no: "QA-LINKED", customerId, ownerId: state.user.id, contractId: c.id, opportunityId: o.id, amount: 100 } });
  expect(await moveStage(o.id, "方案报价")).toMatchObject({ ok: false, error: expect.stringContaining("QA-LINKED") });
  expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("WON");
});
it("J-094 相同阶段重复提交不重复写库/审计", async () => {
  const o = await create();
  await moveStage(o.id, "谈判审核");
  const before = await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } }); const count = await prisma.auditLog.count();
  expect((await moveStage(o.id, "谈判审核")).ok).toBe(true);
  expect(await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).toEqual(before); expect(await prisma.auditLog.count()).toBe(count);
});
it("J-094 旧撤销不能覆盖之后的新修改", async () => {
  const o = await create();
  const result = await moveStage(o.id, "谈判审核");
  expect(result.ok).toBe(true);
  const version = (await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).updatedAt.toISOString();
  await moveStage(o.id, "需求确认");
  expect(await moveStage(o.id, "方案报价", 75, version)).toMatchObject({ ok: false, error: expect.any(String) });
  expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).stage).toBe("需求确认");
});
it("结单写入故障时阶段和状态整体回滚", async () => {
  const o = await create();
  await prisma.$executeRawUnsafe("CREATE TRIGGER qa_close_failure BEFORE INSERT ON OpportunityClose BEGIN SELECT RAISE(ABORT, 'QA close unavailable'); END");
  try { try { await moveStage(o.id, "赢单成交"); } catch {} } finally { await prisma.$executeRawUnsafe("DROP TRIGGER qa_close_failure"); }
  expect(await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).toEqual(o);
  expect(await prisma.auditLog.count()).toBe(0);
});
it("币种写入故障时新建商机整体回滚", async () => {
  await prisma.$executeRawUnsafe("CREATE TRIGGER qa_money_failure BEFORE INSERT ON OpportunityMoney BEGIN SELECT RAISE(ABORT, 'QA money unavailable'); END");
  try { try { await saveOpportunity(input({ currency: "USD" })); } catch {} } finally { await prisma.$executeRawUnsafe("DROP TRIGGER qa_money_failure"); }
  expect(await prisma.opportunity.count()).toBe(0); expect(await prisma.auditLog.count()).toBe(0);
});
