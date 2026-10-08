import { afterAll, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: { id: "", name: "QA", email: "links@qa.local", role: "ADMIN", title: "管理员" } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => state.user }));
vi.mock("@/app/(app)/opportunities/OpportunitiesView", () => ({ default: () => null }));
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import OpportunitiesPage from "@/app/(app)/opportunities/page";
import { loadFollowHistory } from "@/app/(app)/customers/[id]/follow-history-actions";
import { 删商机前清点, deleteOpportunities, restoreOpportunities } from "@/app/(app)/opportunities/actions";
let customerId: string;
beforeEach(async () => {
  await resetDb();
  state.user.id = (await prisma.user.create({ data: { email: state.user.email, name: "QA", password: "qa", role: "ADMIN" } })).id;
  customerId = (await prisma.customer.create({ data: { name: "关联客户", phone: "", salesOwnerId: state.user.id } })).id;
});
afterAll(async () => { await prisma.$disconnect(); });
const create = (id: string, status = "OPEN", createdAt = new Date()) => prisma.opportunity.create({ data: { id, name: "同名商机", customerId, ownerId: state.user.id, amount: 123, probability: status === "WON" ? 100 : 20, stage: status === "WON" ? "赢单成交" : "初步沟通", status, createdAt } });

it("唯一ID直达超过300条截断的已关闭同名商机，不受列表筛选误导", async () => {
  const closed = await create("closed-link", "WON", new Date("2020-01-01"));
  await prisma.opportunity.createMany({ data: Array.from({ length: 301 }, (_, i) => ({ id: `opp-${i}`, name: "同名商机", customerId, ownerId: state.user.id, stage: "初步沟通", createdAt: new Date("2026-01-01") })) });
  const all = await OpportunitiesPage({ searchParams: Promise.resolve({ opportunity: closed.id }) });
  expect(all.props.rows).toHaveLength(300); expect(all.props.rows.some((r: { id: string }) => r.id === closed.id)).toBe(false);
  expect(all.props.focusedOpportunity).toMatchObject({ id: closed.id, status: "WON", customerId, ownerId: state.user.id });
  const filtered = await OpportunitiesPage({ searchParams: Promise.resolve({ opportunity: closed.id, keyword: "完全不匹配", status: "OPEN" }) });
  expect(filtered.props.rows).toEqual([]); expect(filtered.props.focusedOpportunity).toMatchObject({ id: closed.id, name: closed.name });
  expect(filtered.props.focusMissing).toBe(false);
});
it("不存在或异常ID只给不可用提示，不打开空白新建框或同名替代记录", async () => {
  await create("same-name");
  for (const opportunity of ["deleted", "x".repeat(257)]) {
    const page = await OpportunitiesPage({ searchParams: Promise.resolve({ opportunity }) });
    expect(page.props.focusedOpportunity).toBeNull(); expect(page.props.focusMissing).toBe(true);
  }
});
it("分页可见关联数与删除前清点一致，删除解绑/撤销重接后显示对应唯一商机", async () => {
  const o = await create("linked-opp");
  await prisma.followUp.createMany({ data: Array.from({ length: 151 }, (_, i) => ({ id: `linked-${String(i).padStart(4, "0")}`, customerId, ownerId: state.user.id, opportunityId: o.id, occurredAt: new Date("2026-01-01"), type: "PHONE", title: "关联", content: "历史关联", status: "已完成" })) });
  let before: { occurredAt: string; id: string } | undefined, count = 0;
  do {
    const page = await loadFollowHistory(customerId, before); if (!page.ok) throw Error(page.error);
    expect(page.rows.every(row => row.opportunity?.id === o.id && row.opportunity.name === o.name)).toBe(true); count += page.rows.length;
    if (!page.hasMore) break; const last = page.rows.at(-1)!; before = { occurredAt: last.occurredAt, id: last.id };
  } while (true);
  expect(count).toBe(151); expect(await 删商机前清点([o.id])).toMatchObject({ 跟进: count });
  const deleted = await deleteOpportunities([o.id]); if (!deleted.ok) throw Error(deleted.error);
  expect(await loadFollowHistory(customerId)).toMatchObject({ ok: true, rows: expect.arrayContaining([expect.objectContaining({ opportunity: null, opportunityId: null })]) });
  expect(await restoreOpportunities(deleted.快照)).toMatchObject({ ok: true });
  const restored = await loadFollowHistory(customerId); if (!restored.ok) throw Error(restored.error);
  expect(restored.rows.every(row => row.opportunity?.id === o.id)).toBe(true);
  expect(await 删商机前清点([o.id])).toMatchObject({ 跟进: count });
});
