import { beforeEach, afterAll, it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({ user: { id: "", name: "QA", email: "qa", role: "ADMIN", title: "管理员" } }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => state.user }));
vi.mock("@/app/(app)/follow-ups/plans/PlansView", () => ({ default: () => null }));
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import PlansPage from "@/app/(app)/follow-ups/plans/page";
type Row = { key: string; 标题: string; ownerId: string; 完成时间: string | null };
let customerId: string;
const history = async () => (await PlansPage({ searchParams: Promise.resolve({}) })).props.done as Row[];
beforeEach(async () => {
  await resetDb();
  state.user.id = (await prisma.user.create({ data: { email: "history-me", password: "x", name: "我", role: "ADMIN" } })).id;
  customerId = (await prisma.customer.create({ data: { name: "QA", phone: "", salesOwnerId: state.user.id } })).id;
});
afterAll(async () => { await prisma.$disconnect(); });
it("后来修改/转交不重排实际完成时间，历史未知时间不冒充修改时间", async () => {
  for (const [subject, doneAt, updatedAt] of [
    ["先完成后修改", new Date("2026-10-01"), new Date("2026-10-08")],
    ["后完成", new Date("2026-10-02"), new Date("2026-10-02")],
    ["旧计划", null, new Date("2026-10-09")],
  ] as const) await prisma.followPlan.create({ data: { subject, doneAt, updatedAt, done: true, ownerId: state.user.id, customerId, plannedAt: new Date("2026-09-01") } });
  await prisma.task.create({ data: { title: "旧待办", done: true, doneAt: null, updatedAt: new Date("2026-10-10"), ownerId: state.user.id, customerId } });
  const rows = await history();
  expect(rows.map(r => r.标题)).toEqual(["后完成", "先完成后修改", "旧计划", "旧待办"]);
  expect(rows.map(r => r.完成时间)).toEqual(["2026-10-02T00:00:00.000Z", "2026-10-01T00:00:00.000Z", null, null]);
});
it("团队有超过200条更新记录仍保留我的历史，合并窗口不重复", async () => {
  const other = await prisma.user.create({ data: { email: "history-other", password: "x", name: "同事" } });
  await prisma.followPlan.createMany({ data: Array.from({ length: 201 }, (_, i) => ({ subject: `同事计划${i}`, done: true, doneAt: new Date(2026, 9, 8, 12, 0, i), ownerId: other.id, customerId, plannedAt: new Date("2026-09-01") })) });
  await prisma.task.createMany({ data: Array.from({ length: 201 }, (_, i) => ({ title: `同事待办${i}`, done: true, doneAt: new Date(2026, 9, 8, 13, 0, i), ownerId: other.id, customerId })) });
  await prisma.followPlan.create({ data: { subject: "我的早期完成", done: true, doneAt: new Date("2026-10-01"), ownerId: state.user.id, customerId, plannedAt: new Date("2026-09-01") } });
  await prisma.task.create({ data: { title: "我的待办", done: true, doneAt: new Date("2026-10-02"), ownerId: state.user.id, customerId } });
  const rows = await history();
  expect(rows.filter(r => r.ownerId === state.user.id).map(r => r.标题)).toEqual(["我的待办", "我的早期完成"]);
  expect(new Set(rows.map(r => r.key)).size).toBe(rows.length);
  expect(rows.slice(0, 200).every(r => r.ownerId === other.id)).toBe(true);
});
