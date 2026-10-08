import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const state = vi.hoisted(() => ({ user: { id: "acct_history", name: "QA", email: "qa-history", role: "ADMIN", title: "管理员" }, denied: false }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => { if (state.denied) throw Error("Unauthorized"); return state.user; } }));
vi.mock("@/lib/llm", async original => ({ ...(await original<object>()), llmEnabled: async () => false }));
vi.mock("@/app/(app)/customers/[id]/RecordView", () => ({ default: () => null }));
import { prisma, defaultClient as raw } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 忘掉限定 } from "@/lib/team-scope";
import { loadFollowHistory, readFollowHistoryRow, type FollowHistoryCursor } from "@/app/(app)/customers/[id]/follow-history-actions";
import { saveFollowUp, deleteFollowUp, restoreFollowUp } from "@/app/(app)/customers/[id]/actions";
import DetailPage from "@/app/(app)/customers/[id]/page";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-history-"));
let customerId: string;
const at = new Date("2026-01-01T02:00Z");
const cursor = (row: { occurredAt: string; id: string }): FollowHistoryCursor => ({ occurredAt: row.occurredAt, id: row.id });
beforeEach(async () => {
  vi.stubEnv("DESKTOP_LOCAL", "0"); vi.stubEnv("MULTI_TENANT", "0"); state.denied = false; state.user.role = "ADMIN";
  忘掉限定(); await resetDb();
  await raw.user.create({ data: { ...state.user, password: "qa" } });
  customerId = (await raw.customer.create({ data: { name: "历史客户", phone: "", salesOwnerId: state.user.id } })).id;
  await raw.followUp.createMany({ data: Array.from({ length: 153 }, (_, n) => ({ id: `history-${String(n).padStart(4, "0")}`, customerId, ownerId: state.user.id, occurredAt: at, type: "PHONE", title: `跟进${n}`, content: `内容${n}`, status: "已完成" })) });
});
afterEach(() => { 忘掉限定(); vi.unstubAllEnvs(); });
afterAll(async () => { await raw.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });

it("详情首屏取50并告知仍有历史，153条同刻分四页完整无重复", async () => {
  const detail = await DetailPage({ params: Promise.resolve({ id: customerId }), searchParams: Promise.resolve({}) });
  expect(detail.props.followUps).toHaveLength(50); expect(detail.props.followUpsHasMore).toBe(true);
  const ids: string[] = []; let before: FollowHistoryCursor | undefined;
  do {
    const page = await loadFollowHistory(customerId, before); if (!page.ok) throw Error(page.error);
    expect(page.rows.length).toBeLessThanOrEqual(50); ids.push(...page.rows.map(r => r.id));
    if (!page.hasMore) break; before = cursor(page.rows.at(-1)!);
  } while (true);
  expect(ids).toEqual(Array.from({ length: 153 }, (_, n) => `history-${String(152 - n).padStart(4, "0")}`));
  expect(new Set(ids).size).toBe(153);
});
it("游标那条被删/新增更近记录后，下一页不重复、不跳过同刻旧记录", async () => {
  const first = await loadFollowHistory(customerId); if (!first.ok) throw Error(first.error);
  const before = cursor(first.rows.at(-1)!);
  await raw.followUp.delete({ where: { id: before.id } });
  await raw.followUp.create({ data: { id: "newer", customerId, ownerId: state.user.id, occurredAt: new Date(at.getTime() + 1000), type: "PHONE", title: "新", content: "新", status: "已完成" } });
  const second = await loadFollowHistory(customerId, before); if (!second.ok) throw Error(second.error);
  expect(second.rows).toHaveLength(50); expect(second.rows[0].id).toBe("history-0102"); expect(second.rows.at(-1)!.id).toBe("history-0053");
  expect(second.rows.some(r => r.id === "newer")).toBe(false);
});
it("第51条可带原文/日历语义读取，编辑版本闸门、删除及撤销后重读最新", async () => {
  const id = "history-0102";
  await raw.followUp.update({ where: { id }, data: { dueAt: new Date("2026-01-01T16:00Z"), dueOn: "2026-01-02", dueHasTime: false, source: { create: { text: "历史原文" } } } });
  const r = await readFollowHistoryRow(customerId, id); if (!r.ok || !r.row) throw Error("read");
  expect(r.row).toMatchObject({ dueAt: "2026-01-02", dueHasTime: false, sourceText: "历史原文" });
  const input = { id, customerId, type: r.row.type, status: r.row.status, occurredAt: r.row.occurredAt, dueAt: r.row.dueAt, dueHasTime: false, content: "旧记录改好了", 版本: r.row.updatedAt };
  expect(await saveFollowUp(input)).toMatchObject({ ok: true });
  expect(await saveFollowUp({ ...input, content: "过期覆盖" })).toMatchObject({ ok: false });
  expect(await readFollowHistoryRow(customerId, id)).toMatchObject({ ok: true, row: { content: "旧记录改好了" } });
  const deleted = await deleteFollowUp(id, customerId); if (!deleted.ok) throw Error(deleted.error);
  expect(await readFollowHistoryRow(customerId, id)).toMatchObject({ ok: true, row: null });
  expect(await restoreFollowUp(deleted.快照)).toMatchObject({ ok: true });
  expect(await readFollowHistoryRow(customerId, id)).toMatchObject({ ok: true, row: { content: "旧记录改好了", sourceText: "历史原文", dueAt: "2026-01-02" } });
});
it("业务员分页/单条重读受真实限定层保护，不能通过客户ID或记录ID读同事资料", async () => {
  const other = await raw.user.create({ data: { name: "同事", email: "other-history", password: "qa" } });
  const hidden = await raw.customer.create({ data: { name: "同事客户", phone: "", salesOwnerId: other.id } });
  await raw.followUp.create({ data: { id: "hidden-follow", customerId: hidden.id, ownerId: other.id, occurredAt: at, type: "PHONE", title: "密", content: "不能读取", status: "已完成" } });
  await raw.user.update({ where: { id: state.user.id }, data: { role: "SALES" } }); state.user.role = "SALES";
  fs.writeFileSync(path.join(dir, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: "dk_qa", accountId: "history", name: "QA", contact: state.user.email, models: [], loggedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(dir, ".team.json"), JSON.stringify({ teamId: "history-team", key: "k".repeat(43), joinSecret: "qa", device: "history-device", pulled: 0 }));
  vi.stubEnv("DESKTOP_LOCAL", "1"); vi.stubEnv("CRM_DATA_DIR", dir); 忘掉限定();
  expect(await loadFollowHistory(hidden.id)).toMatchObject({ ok: false });
  expect(await readFollowHistoryRow(hidden.id, "hidden-follow")).toMatchObject({ ok: false });
  expect(await readFollowHistoryRow(customerId, "hidden-follow")).toMatchObject({ ok: true, row: null });
  expect(await loadFollowHistory(customerId)).toMatchObject({ ok: true, rows: expect.any(Array) });
  expect(await prisma.customer.count()).toBe(1);
});
it("未认证先拒绝；坏游标/不存在客户不返回历史", async () => {
  state.denied = true; await expect(loadFollowHistory(customerId)).rejects.toThrow("Unauthorized"); state.denied = false;
  for (const before of [null, { id: "x", occurredAt: "2026-02-30T00:00:00.000Z" }, { id: "", occurredAt: at.toISOString() }, { id: "x", occurredAt: 123 }]) {
    expect(await loadFollowHistory(customerId, before as unknown as FollowHistoryCursor)).toMatchObject({ ok: false });
  }
  expect(await loadFollowHistory("missing")).toMatchObject({ ok: false });
});
