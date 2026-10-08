import { beforeEach, afterEach, afterAll, it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({ user: { id: "", name: "老板", email: "boss", role: "ADMIN", title: "管理员" } }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => state.user }));
vi.mock("@/lib/llm", () => ({ llmEnabled: async () => false }));
vi.mock("@/app/(app)/contacts/ContactsView", () => ({ default: () => null }));
vi.mock("@/app/(app)/follow-ups/FollowUpsView", () => ({ default: () => null }));
vi.mock("@/app/(app)/dashboard/Board", () => ({ default: () => null }));
vi.mock("@/app/(app)/overview/DataShell", () => ({ default: () => null }));
vi.mock("@/app/(app)/reports/ReportsView", () => ({ default: () => null }));
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import ContactsPage from "@/app/(app)/contacts/page";
import FollowUpsPage from "@/app/(app)/follow-ups/page";
import DataPage from "@/app/(app)/overview/page";
import { 加载复盘 } from "@/app/(app)/overview/data";
let salesId: string; let customerId: string;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-08T12:00:00+08:00"));
  await resetDb(); state.user.id = (await prisma.user.create({ data: { email: "boss", name: "老板", password: "x", role: "ADMIN" } })).id;
  salesId = (await prisma.user.create({ data: { email: "sales-a", name: "同名", password: "x", role: "SALES" } })).id;
  customerId = (await prisma.customer.create({ data: { name: "QA", phone: "", salesOwnerId: salesId } })).id;
});
afterEach(() => vi.useRealTimers()); afterAll(async () => { await prisma.$disconnect(); });
it("联系人服务器数据保留同名成员的不同ID和登录名", async () => {
  const other = await prisma.user.create({ data: { email: "sales-b", name: "同名", password: "x", role: "SALES" } });
  const otherCustomer = await prisma.customer.create({ data: { name: "QA乙", phone: "", salesOwnerId: other.id } });
  for (const [id, name] of [[customerId, "甲联系人"], [otherCustomer.id, "乙联系人"]]) await prisma.contact.create({ data: { name, customerId: id } });
  const rows = (await ContactsPage({ searchParams: Promise.resolve({}) })).props.rows;
  expect(rows.map((r: { ownerId: string }) => r.ownerId).sort()).toEqual([salesId, other.id].sort());
  expect(rows.map((r: { ownerEmail: string }) => r.ownerEmail).sort()).toEqual(["sales-a", "sales-b"]);
});
it("跟进筛选包括管理员及有历史的停用成员，逐人筛选不混记录", async () => {
  const old = await prisma.user.create({ data: { email: "old", name: "停用同事", active: false, password: "x" } });
  for (const ownerId of [state.user.id, salesId, old.id]) await prisma.followUp.create({ data: { type: "PHONE", title: ownerId, content: "QA", customerId, ownerId } });
  for (const ownerId of [state.user.id, salesId, old.id]) {
    const props = (await FollowUpsPage({ searchParams: Promise.resolve({ ownerId }) })).props;
    expect(props.users.map((u: { id: string }) => u.id)).toContain(ownerId);
    expect(props.总数).toBe(1); expect(props.rows[0].title).toBe(ownerId);
  }
});
it("只有一个在职销售时仍显示停用同事业绩，恢复后金额不变", async () => {
  const old = await prisma.user.create({ data: { email: "old-sales", name: "停用同事", active: false, password: "x", role: "SALES" } });
  const contract = await prisma.contract.create({ data: { amount: 1200, signedAt: new Date("2026-10-02"), customerId } });
  await prisma.contractOwner.create({ data: { contractId: contract.id, salesOwnerId: old.id } });
  const page = () => DataPage({ searchParams: Promise.resolve({ view: "本月" }) });
  const props = (await page()).props.children.props;
  expect(props.单人).toBe(false); expect(props.bySales).toMatchObject([{ id: old.id, amount: 1200 }]);
  await prisma.user.update({ where: { id: old.id }, data: { active: true } });
  expect((await page()).props.children.props.bySales).toEqual(props.bySales);
});
it("无历史其他归属仍隐藏冗余单人表；来源与负责人空值明确区分", async () => {
  await prisma.contract.create({ data: { amount: 100, signedAt: new Date("2026-10-02"), customerId } });
  const props = (await DataPage({ searchParams: Promise.resolve({ view: "本月" }) })).props.children.props;
  expect(props.单人).toBe(true);
  const data = await 加载复盘(new Date("2026-10-01"), new Date("2026-11-01"), "day");
  expect(data.byChannelOwner[0].name).toBe("无渠道负责人"); expect(data.byChannel[0].name).toBe("无来源渠道");
});
