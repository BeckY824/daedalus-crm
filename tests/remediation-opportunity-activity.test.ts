import { afterAll, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: { id: "", name: "QA管理员", email: "qa", role: "ADMIN", title: "管理员" } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => state.user, requireAdmin: async () => state.user }));
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache } from "@/lib/settings";
import { dayjs } from "@/lib/utils";
import { loadWatchlistPage } from "@/lib/sentinel-data";
import { 转交商机 } from "@/lib/opportunity-activity";
import { 带走并记下 } from "@/lib/carry-over-db";
import { assignSalesOwner, patchCustomer, 撤销改负责人 } from "@/app/(app)/customers/actions";
import { 领取, 放进公海, 撤销公海 } from "@/app/(app)/customers/pool-actions";
import { deactivateUser } from "@/app/(app)/settings/actions";
import { deleteOpportunities, restoreOpportunities, saveOpportunity, moveStage, setOppStatus } from "@/app/(app)/opportunities/actions";
let customerId: string; let otherId: string; let old: Date;
beforeEach(async () => {
  await resetDb(); invalidateSettingsCache();
  state.user.id = (await prisma.user.create({ data: { email: "activity-me", name: "QA管理员", role: "ADMIN", password: "x" } })).id;
  otherId = (await prisma.user.create({ data: { email: "activity-other", name: "QA同事", role: "SALES", password: "x" } })).id;
  // 已流失客户不触发沉睡信号，单独观察仍进行中的商机信号。
  customerId = (await prisma.customer.create({ data: { name: "QA客户", phone: "", salesOwnerId: state.user.id, followStatus: "已流失" } })).id;
  old = new Date(Date.now() - 20 * 86400_000);
});
afterAll(async () => { await prisma.$disconnect(); });
const create = (patch = {}) => prisma.opportunity.create({ data: { name: "QA商机", customerId, ownerId: state.user.id, amount: 100, stage: "方案报价", status: "OPEN", probability: 75, updatedAt: old, ...patch } });
const input = (patch = {}) => ({ name: "QA商机", customerId, ownerId: state.user.id, amount: 100, stage: "方案报价", status: "OPEN", probability: 75, ...patch });
const read = (id: string) => prisma.opportunity.findUniqueOrThrow({ where: { id } });
async function stalled() { return (await loadWatchlistPage(dayjs())).items.filter((x) => x.kind === "stalled_opp"); }

it("L-029 批量转交及撤销都不掩盖20天停滞；旧编辑版本仍被拒绝", async () => {
  const o = await create(); expect(await stalled()).toHaveLength(1);
  const assigned = await assignSalesOwner([customerId], otherId); expect(assigned.ok).toBe(true);
  if (!assigned.ok) throw new Error(assigned.error);
  const after = await read(o.id); expect(after.ownerId).toBe(otherId); expect(after.activityAt).toEqual(old); expect(after.updatedAt.getTime()).toBeGreaterThan(o.updatedAt.getTime());
  expect(await stalled()).toHaveLength(1);
  expect(await saveOpportunity(input({ id: o.id, 版本: o.updatedAt.toISOString() }))).toMatchObject({ ok: false });
  expect((await read(o.id)).ownerId).toBe(otherId);
  expect((await 撤销改负责人(assigned.原值!, otherId, assigned.带过来)).ok).toBe(true);
  expect((await read(o.id)).activityAt).toEqual(old); expect((await read(o.id)).ownerId).toBe(state.user.id); expect(await stalled()).toHaveLength(1);
});
it("L-029 单格转交沿用业务时间，不碰已经结单或别人的商机", async () => {
  const o = await create(); const closed = await create({ status: "WON" }); const other = await create({ ownerId: otherId });
  expect((await patchCustomer(customerId, "salesOwnerId", otherId)).ok).toBe(true);
  expect((await read(o.id)).activityAt).toEqual(old); expect(await stalled()).toHaveLength(1);
  expect(await read(closed.id)).toEqual(closed); expect(await read(other.id)).toEqual(other);
});
it("L-029 公海领取及撤销保留停滞，未领取前已有的活不改归属", async () => {
  await prisma.customer.update({ where: { id: customerId }, data: { salesOwnerId: otherId } });
  const o = await create({ ownerId: otherId }); const mine = await create();
  expect((await 放进公海([customerId])).ok).toBe(true);
  const claimed = await 领取([customerId]); expect(claimed.ok).toBe(true);
  if (!claimed.ok) throw new Error(claimed.error);
  expect((await read(o.id)).activityAt).toEqual(old); expect(await stalled()).toHaveLength(1);
  expect((await 撤销公海("领取", claimed.原负责人!, claimed.带过来)).ok).toBe(true);
  expect((await read(o.id)).ownerId).toBe(otherId); expect((await read(o.id)).activityAt).toEqual(old); expect(await read(mine.id)).toEqual(mine);
});
it("L-029 停用转交保留业务时间，历史赢单仍归停用成员", async () => {
  const o = await create({ ownerId: otherId }); const won = await create({ ownerId: otherId, status: "WON" });
  expect((await deactivateUser(otherId, state.user.id)).ok).toBe(true);
  expect((await read(o.id)).ownerId).toBe(state.user.id); expect((await read(o.id)).activityAt).toEqual(old); expect(await stalled()).toHaveLength(1);
  expect(await read(won.id)).toEqual(won);
});
it("L-029 商机编辑框仅换人或原样保存不重计停滞；修改金额才更新业务时间", async () => {
  const o = await create();
  expect((await saveOpportunity(input({ id: o.id, ownerId: otherId }))).ok).toBe(true);
  expect((await read(o.id)).activityAt).toEqual(old); expect(await stalled()).toHaveLength(1);
  expect((await saveOpportunity(input({ id: o.id, ownerId: otherId }))).ok).toBe(true);
  expect((await read(o.id)).activityAt).toEqual(old);
  expect((await saveOpportunity(input({ id: o.id, ownerId: otherId, amount: 200 }))).ok).toBe(true);
  expect((await read(o.id)).activityAt!.getTime()).toBeGreaterThan(old.getTime()); expect(await stalled()).toHaveLength(0);
});
it.each(["stage", "currency", "status"])("实际%s推进从现在重计停滞", async (kind) => {
  const o = await create({ activityAt: old });
  const result = kind === "stage" ? await moveStage(o.id, "谈判审核") : kind === "status" ? await setOppStatus(o.id, "LOST") : await saveOpportunity(input({ id: o.id, currency: "USD" }));
  expect(result.ok).toBe(true); expect((await read(o.id)).activityAt!.getTime()).toBeGreaterThan(old.getTime()); expect(await stalled()).toHaveLength(0);
});
it("删除再撤销保留真实停滞时刻，不当成今天刚推进", async () => {
  const o = await create(); const deleted = await deleteOpportunities([o.id]); expect(deleted.ok).toBe(true);
  if (!deleted.ok) throw new Error("delete failed");
  expect((await restoreOpportunities(deleted.快照)).ok).toBe(true);
  expect((await read(o.id)).activityAt).toEqual(old); expect(await stalled()).toHaveLength(1);
});
it("转交事务写入失败，业务时间和负责人都回滚", async () => {
  const o = await create();
  await prisma.$executeRawUnsafe("CREATE TRIGGER qa_activity_failure BEFORE UPDATE OF ownerId ON Opportunity BEGIN SELECT RAISE(ABORT, 'QA owner write failed'); END");
  try { await expect(带走并记下([{ customerId, 旧: state.user.id }], otherId)).rejects.toThrow(); }
  finally { await prisma.$executeRawUnsafe("DROP TRIGGER qa_activity_failure"); }
  expect(await read(o.id)).toEqual(o);
});
it("601条分批转交分别保留旧时间；版本号始终增加，非目标不动", async () => {
  await prisma.opportunity.createMany({ data: Array.from({ length: 601 }, (_, i) => ({ id: `activity-${i}`, name: `商机${i}`, customerId, ownerId: state.user.id, updatedAt: new Date(old.getTime() + i * 1000) })) });
  const untouched = await create({ ownerId: otherId });
  await prisma.$transaction((tx) => 转交商机(tx, { ownerId: state.user.id }, otherId));
  const rows = await prisma.opportunity.findMany({ where: { id: { startsWith: "activity-" } } }); expect(rows).toHaveLength(601);
  for (const row of rows) {
    const original = old.getTime() + Number(row.id.slice(9)) * 1000;
    expect(row.activityAt!.getTime()).toBe(original); expect(row.updatedAt.getTime()).toBeGreaterThan(original); expect(row.ownerId).toBe(otherId);
  }
  expect(await read(untouched.id)).toEqual(untouched);
  const future = await create({ updatedAt: new Date(Date.now() + 1000), activityAt: old });
  await prisma.$transaction((tx) => 转交商机(tx, { id: future.id }, otherId));
  expect((await read(future.id)).updatedAt.getTime()).toBe(future.updatedAt.getTime() + 1);
});
