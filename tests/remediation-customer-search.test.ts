import { afterAll, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: { id: "", name: "QA", email: "picker@qa.local", role: "ADMIN", title: "管理员" } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => state.user }));
vi.mock("@/app/(app)/opportunities/OpportunitiesView", () => ({ default: () => null }));
vi.mock("@/app/(app)/opportunities/pipeline/PipelineView", () => ({ default: () => null }));
vi.mock("@/app/(app)/contacts/ContactsView", () => ({ default: () => null }));
import { defaultClient as db } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 搜客户, 取客户选项 } from "@/app/(app)/customers/[id]/pick";
import OpportunitiesPage from "@/app/(app)/opportunities/page";
import ContactsPage from "@/app/(app)/contacts/page";
import PipelinePage from "@/app/(app)/opportunities/pipeline/page";
beforeEach(async () => {
  await resetDb(); state.user.id = (await db.user.create({ data: { email: state.user.email, name: "QA", password: "qa", role: "ADMIN" } })).id;
  await db.customer.createMany({ data: Array.from({ length: 1001 }, (_, n) => ({ id: `pick-${n}`, name: `同名${n % 2}`, school: `公司${n}`, phone: `138${String(n).padStart(8, "0")}`, salesOwnerId: state.user.id })) });
});
afterAll(async () => { await db.$disconnect(); });
it("1001位客户页面不传整表，联系人保留可新建状态，管道同样按需选择", async () => {
  const spy = vi.spyOn(db.customer, "findMany");
  try {
    expect((await OpportunitiesPage({ searchParams: Promise.resolve({}) })).props.customers).toEqual([]);
    const contacts = await ContactsPage({ searchParams: Promise.resolve({}) });
    expect(contacts.props.学员们).toEqual([]); expect(contacts.props.有客户).toBe(true);
    expect((await PipelinePage()).props.customers).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});
it("展开最多8位、搜索最多20位，公司/电话可定位第1001位，同名有区分信息", async () => {
  const spy = vi.spyOn(db.customer, "findMany");
  try {
    expect(await 搜客户("")).toHaveLength(8); expect(await 搜客户("同名")).toHaveLength(20);
    expect(await 搜客户("公司1000")).toEqual([{ id: "pick-1000", name: "同名0", 附注: "公司1000 · 13800001000" }]);
    expect(await 搜客户("13800001000")).toHaveLength(1);
    expect(spy.mock.calls.map(([args]) => args?.take)).toEqual([8, 20, 20, 20]);
  } finally { spy.mockRestore(); }
});
it("new=1冷入口预填单个实际存在客户，取消前不写商机；无效ID不注入下拉", async () => {
  const page = await OpportunitiesPage({ searchParams: Promise.resolve({ new: "1", customer: "pick-1000" }) });
  expect(page.props.directNew).toBe(true); expect(page.props.initialCustomer).toEqual({ id: "pick-1000", name: "同名0" }); expect(page.props.customers).toEqual([]);
  expect(await db.opportunity.count()).toBe(0);
  const invalid = await OpportunitiesPage({ searchParams: Promise.resolve({ new: "1", customer: "missing" }) }); expect(invalid.props.initialCustomer).toBeNull();
});
it("编辑只补选中标签；错误输入/已删客户不返回记录", async () => {
  expect(await 取客户选项("pick-1000")).toMatchObject({ id: "pick-1000", name: "同名0", 附注: expect.stringContaining("公司1000") });
  expect(await 取客户选项("missing")).toBeNull(); expect(await 取客户选项("x".repeat(257))).toBeNull();
  expect(await 搜客户(null as unknown as string)).toEqual([]);
});
