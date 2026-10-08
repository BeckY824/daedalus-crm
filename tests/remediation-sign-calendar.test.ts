import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: { id: "sign-qa", name: "QA", email: "sign-qa", role: "ADMIN", title: "管理员" } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => state.user }));
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache } from "@/lib/settings";
import { saveCustomer, patchCustomer, type CustomerInput } from "@/app/(app)/customers/actions";
import { 客户行字段, 成客户行 } from "@/app/(app)/customers/query";
import { 客户导出表 } from "@/app/(app)/customers/export-table";
import { 执行导入, 预览导入, 撤销批次, type 导入方案 } from "@/app/(app)/customers/import-actions";
import { DEFAULT_BUSINESS } from "@/lib/business-config";
import { 字段表, 猜列 } from "@/lib/import/fields";
import { 摊开 } from "@/lib/import/plan";
import { TOOLS } from "@/lib/agent/tools";
import { buildProposal } from "@/lib/agent/proposals";
import { 读现值 } from "@/lib/agent/current-values";
import { applyProposal } from "@/app/(app)/dashboard/apply";
const originalTZ = process.env.TZ;
beforeEach(async () => { await resetDb(); invalidateSettingsCache(); process.env.TZ = "Asia/Shanghai"; await prisma.user.create({ data: { ...state.user, password: "qa" } }); });
afterEach(() => { process.env.TZ = originalTZ; }); afterAll(async () => { await prisma.$disconnect(); });
const input = (date: string | Date | null): CustomerInput => ({ name: "日期客户", phone: "13800000001", school: null, grade: null, major: null, followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: date, remark: null, salesOwnerId: state.user.id, channelId: null, referrerCustomerId: null });
async function create(date: string | Date | null = "2026-10-08") { const r = await saveCustomer(input(date)); if (!r.ok) throw Error(r.error); return prisma.customer.findUniqueOrThrow({ where: { id: r.id } }); }
async function form(id: string) { const r = await prisma.customer.findUniqueOrThrow({ where: { id }, select: 客户行字段 }); return 成客户行(r, p => p); }
const ctx = () => ({ userId: state.user.id, userName: "QA", b: DEFAULT_BUSINESS, recordOffset: 0, proposals: [] });
function plan(date: string, phone = "13800000001"): 导入方案 { const 表头 = ["姓名", "手机号", "预计签约"]; return { 表头, 数据: [["日期客户", phone, date]], 映射: 猜列(表头, 字段表(DEFAULT_BUSINESS)), 重复行: "补空" }; }
it("保存/列表/导出跨时区保留原日历日，旧客户端ISO未变继续保留，清空同步清元数据", async () => {
  const c = await create(); expect(c.expectedSignOn).toBe("2026-10-08");
  process.env.TZ = "America/New_York";
  const row = await form(c.id); expect(row.expectedSignAt).toBe("2026-10-08");
  const table = 客户导出表([row], DEFAULT_BUSINESS); expect(table.body[0][table.head.indexOf("预计签约")]).toBe("2026-10-08");
  expect(await saveCustomer({ ...input(c.expectedSignAt), id: c.id, updatedAt: c.updatedAt.toISOString(), remark: "旧端原样交回" })).toMatchObject({ ok: true });
  expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).expectedSignOn).toBe("2026-10-08");
  expect(await patchCustomer(c.id, "expectedSignAt", null)).toEqual({ ok: true });
  expect(await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ expectedSignAt: null, expectedSignOn: null });
});
it("跨时区只改备注自动合并别人的新日期，双方改日期则冲突且日期与元数据不拆开", async () => {
  const c = await create(); process.env.TZ = "America/New_York"; const row = await form(c.id);
  const base = { ...input(row.expectedSignAt), ...row };
  await patchCustomer(c.id, "expectedSignAt", "2026-10-09");
  expect(await saveCustomer({ ...base, base, updatedAt: row.updatedAt, remark: "只改备注" })).toMatchObject({ ok: true });
  expect(await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ expectedSignOn: "2026-10-09", remark: "只改备注" });
  const r = await saveCustomer({ ...base, base, updatedAt: row.updatedAt, expectedSignAt: "2026-10-10" });
  expect(r).toMatchObject({ ok: false, conflict: { fields: ["预计签约时间"] } });
  expect((await form(c.id)).expectedSignAt).toBe("2026-10-09");
});
it("只改日期、别人改备注时成对合并；无效日期原行不变", async () => {
  const c = await create(); const row = await form(c.id); const base = { ...input(row.expectedSignAt), ...row };
  await patchCustomer(c.id, "remark", "同事备注");
  expect(await saveCustomer({ ...base, base, expectedSignAt: "2026-10-11" })).toMatchObject({ ok: true });
  const after = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } }); expect(after).toMatchObject({ remark: "同事备注", expectedSignOn: "2026-10-11" });
  expect(await saveCustomer({ ...input("2026-02-30"), id: c.id, updatedAt: after.updatedAt.toISOString() })).toMatchObject({ ok: false });
  expect(await patchCustomer(c.id, "expectedSignAt", "2026-02-30")).toMatchObject({ ok: false });
  expect(await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).toEqual(after);
});
it("历史记录未改日期不补猜原日历日", async () => {
  const old = new Date("2026-10-07T16:00:00Z"); const c = await create(old); process.env.TZ = "America/New_York";
  const row = await form(c.id); expect(row.expectedSignAt).toBe(old.toISOString());
  expect(await saveCustomer({ ...input(row.expectedSignAt), id: c.id, updatedAt: row.updatedAt, remark: "只改备注" })).toMatchObject({ ok: true });
  expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).expectedSignOn).toBeNull();
});
it("导入文本/Excel序号在Santiago午夜缺口保留日历日；补空撤销和旧撤销快照清元数据", async () => {
  process.env.TZ = "America/Santiago";
  for (const raw of ["2026年9月6日", String((Date.parse("2026-09-06T00:00Z") / 86400000) + 25569)]) {
    const p = plan(raw); expect(摊开({ ...p, 字段表: 字段表(DEFAULT_BUSINESS) })[0].值.expectedSignAt).toBe("2026-09-06");
  }
  const c = await create(null); const p = plan("2026-09-06"); expect(await 预览导入(p)).toMatchObject({ ok: true, 预览: { 可补空: 1 } });
  const r = await 执行导入(p, "calendar.csv"); if (!r.ok) throw Error(r.error);
  expect((await form(c.id)).expectedSignAt).toBe("2026-09-06");
  expect(await 撤销批次(r.batchId)).toMatchObject({ ok: true }); expect(await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ expectedSignAt: null, expectedSignOn: null });
  const old = await 执行导入(p, "old.csv"); if (!old.ok) throw Error(old.error);
  const saved = await prisma.importRow.findFirstOrThrow({ where: { batchId: old.batchId } }); const before = JSON.parse(saved.before!); delete before.expectedSignOn;
  await prisma.importRow.update({ where: { id: saved.id }, data: { before: JSON.stringify(before) } });
  expect(await 撤销批次(old.batchId)).toMatchObject({ ok: true }); expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).expectedSignOn).toBeNull();
  const added = await 执行导入(plan("2026-09-06", "13800000002"), "new.csv"); expect(added).toMatchObject({ ok: true, 新建: 1 });
  expect(await prisma.customer.findFirstOrThrow({ where: { phone: "13800000002" } })).toMatchObject({ expectedSignOn: "2026-09-06" });
});
it("AI专用/通用日期筛选和现值均按原日历日，提议确认写入原日历日", async () => {
  const c = await create(); process.env.TZ = "America/New_York";
  const search = (await TOOLS.find(t => t.name === "search_customers")!.run({ expectedSignFrom: "2026-10-08", expectedSignTo: "2026-10-08" }, ctx())).data;
  expect(search).toMatchObject({ total: 1, customers: [{ expectedSignAt: "2026-10-08" }] });
  const query = (await TOOLS.find(t => t.name === "query_records")!.run({ 表: "客户", 条件: [{ 字段: "预计签约", 运算: "不早于", 值: "2026-10-08" }, { 字段: "预计签约", 运算: "不晚于", 值: "2026-10-08" }] }, ctx())).data;
  expect(query).toMatchObject({ 总数: 1, 结果: [expect.objectContaining({ 预计签约时间: "2026-10-08" })] });
  expect(await 读现值(c.id)).toMatchObject({ expectedSignAt: "2026-10-08" });
  const proposal = buildProposal("sign-change", "update_customer", { id: c.id, name: c.name }, { reason: "核对日期", changes: { expectedSignAt: "2026-10-10" } }, DEFAULT_BUSINESS); if (!proposal.ok) throw Error(proposal.error);
  expect(await applyProposal(proposal.proposal)).toMatchObject({ ok: true });
  expect(await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ expectedSignOn: "2026-10-10" });
});

it("预计签约搜索在取30条前按原日历日排序，不漏跨时区的月初记录", async () => {
  await prisma.customer.createMany({ data: Array.from({ length: 31 }, (_, i) => ({ id: `sign-${String(i).padStart(2, "0")}`, name: `客户${i}`, phone: "", salesOwnerId: state.user.id, expectedSignAt: new Date("2026-10-07T16:00:00Z"), expectedSignOn: i === 30 ? "2026-10-01" : "2026-10-08" })) });
  process.env.TZ = "America/New_York";
  const r = (await TOOLS.find(t => t.name === "search_customers")!.run({ expectedSignFrom: "2026-10-01", expectedSignTo: "2026-10-31" }, ctx())).data as { total: number; customers: { id: string }[] };
  expect(r.total).toBe(31); expect(r.customers).toHaveLength(30); expect(r.customers[0].id).toBe("sign-30");
});
it("预计签约日期的修改留痕使用原日历日", async () => {
  const c = await create(); process.env.TZ = "America/New_York"; await patchCustomer(c.id, "expectedSignAt", "2026-10-10");
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: c.id, action: "update" } });
  expect(JSON.parse(audit.detail!)).toEqual([expect.objectContaining({ 原值: "2026-10-08", 新值: "2026-10-10" })]);
});
