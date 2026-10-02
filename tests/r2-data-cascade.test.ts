/**
 * 二轮排查（r2-data）· 删除级联。
 *
 * 删客户（联系人留未归属、跟进 / 商机 / 计划 / 待办 / 签约一起删）、删商机、删联系人、删渠道（有客户挂着）、
 * 删线索（已转化）之后：库里不能有悬空引用，各页的取数不能报错，各处数字跟着变。
 * 「各页」用的是真实的 page.tsx（服务端组件，只跑它的取数，View 换成空壳），这样页面里自己写的查询也覆盖到。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user, getCurrentUser: async () => mocks.user }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, redirect: () => { throw new Error("REDIRECT"); } }));
// 页面只跑取数，界面组件换成空壳（它们是客户端组件，不在这里测）
for (const m of [
  "@/app/(app)/follow-ups/FollowUpsView", "@/app/(app)/follow-ups/plans/PlansView", "@/app/(app)/opportunities/OpportunitiesView",
  "@/app/(app)/opportunities/pipeline/PipelineView", "@/app/(app)/contacts/ContactsView", "@/app/(app)/leads/LeadsView",
  "@/app/(app)/channels/ChannelsView", "@/app/(app)/customers/CustomersView", "@/app/(app)/customers/[id]/RecordView",
]) vi.doMock(m, () => ({ default: () => null }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人, 造客户 } from "./r2-data-helpers";
import { deleteCustomers, 删除前清点, saveContract } from "@/app/(app)/customers/actions";
import { saveFollowUp, deleteFollowUp, savePlan, saveTask, saveContact, deleteContact, restoreContact, detachContact } from "@/app/(app)/customers/[id]/actions";
import { saveOpportunity, setOppStatus, deleteOpportunities, restoreOpportunities } from "@/app/(app)/opportunities/actions";
import { saveLead, convertLead, deleteLeads } from "@/app/(app)/leads/actions";
import { saveChannel, deleteChannel, toggleChannel } from "@/app/(app)/channels/actions";
import { 执行导入, 撤销批次 } from "@/app/(app)/customers/import-actions";
import { 解析CSV, 成表 } from "@/lib/import/parse";
import { 字段表, 猜列 } from "@/lib/import/fields";
import { DEFAULT_BUSINESS } from "@/lib/business-config";
import { 取提醒项 } from "@/lib/reminders-db";
import { 数逾期跟进 } from "@/lib/overdue";
import { loadWatchlist } from "@/lib/sentinel-data";
import { 加载复盘 } from "@/app/(app)/overview/data";
import { 导出客户 } from "@/app/(app)/customers/export-action";
import { dayjs } from "@/lib/utils";

let 我: string;
beforeEach(async () => {
  await resetDb();
  我 = (await 造本人()).id;
  mocks.user = { ...mocks.user, id: 我 };
});
afterAll(async () => { await prisma.$disconnect(); });

const 昨天 = () => new Date(Date.now() - 86400000).toISOString();

/** 一位「什么都挂着」的客户：联系人 2、跟进 2（一条带 AI 原文、一条指着联系人和商机）、商机 2（一个赢单）、计划、待办、签约 */
async function 满满的客户(name = "海川外贸") {
  const c = await 造客户(我, { name });
  await saveContact({ customerId: c.id, name: "王总", phone: "13800000009", isPrimary: true });
  await saveContact({ customerId: c.id, name: "李工", isPrimary: false });
  const 王 = await prisma.contact.findFirstOrThrow({ where: { name: "王总" } });
  await saveOpportunity({ name: "年框", customerId: c.id, amount: 50000, stage: "方案报价", status: "OPEN", probability: 60, ownerId: 我 });
  await saveOpportunity({ name: "试单", customerId: c.id, amount: 3000, stage: "需求确认", status: "OPEN", probability: 40, ownerId: 我 });
  const [年框, 试单] = await prisma.opportunity.findMany({ where: { customerId: c.id }, orderBy: { amount: "desc" } });
  await setOppStatus(试单.id, "WON");
  await saveFollowUp({ customerId: c.id, type: "PHONE", content: "聊报价", status: "已完成", occurredAt: 昨天(), contactId: 王.id, opportunityId: 年框.id, sourceText: "原话" });
  await saveFollowUp({ customerId: c.id, type: "REMIND", content: "提醒回电", status: "待处理", occurredAt: new Date().toISOString(), dueAt: 昨天() });
  await savePlan({ customerId: c.id, subject: "回访", plannedAt: 昨天(), method: "电话沟通" });
  await saveTask({ customerId: c.id, title: "发合同", dueAt: 昨天() });
  await saveContract({ customerId: c.id, amount: 3000, signedAt: new Date(), remark: null });
  return { c, 王, 年框, 试单 };
}

/** SQLite 自己查一遍外键：有悬空引用会列出来 */
async function 外键体检() {
  return prisma.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check");
}

/** 跑一遍各页的服务端取数（page.tsx 本身），抛了就是页面打不开 */
async function 各页取数(还在的客户?: string) {
  const sp = Promise.resolve({});
  const 页 = {
    跟进记录: () => import("@/app/(app)/follow-ups/page").then((m) => m.default({ searchParams: sp } as never)),
    跟进计划: () => import("@/app/(app)/follow-ups/plans/page").then((m) => m.default({ searchParams: sp } as never)),
    商机列表: () => import("@/app/(app)/opportunities/page").then((m) => m.default({ searchParams: sp } as never)),
    商机管道: () => import("@/app/(app)/opportunities/pipeline/page").then((m) => m.default()),
    联系人: () => import("@/app/(app)/contacts/page").then((m) => m.default({ searchParams: sp } as never)),
    线索: () => import("@/app/(app)/leads/page").then((m) => m.default({ searchParams: sp } as never)),
    渠道: () => import("@/app/(app)/channels/page").then((m) => m.default()),
    客户列表: () => import("@/app/(app)/customers/page").then((m) => m.default({ searchParams: sp } as never)),
    ...(还在的客户 ? { 记录页: () => import("@/app/(app)/customers/[id]/page").then((m) => m.default({ params: Promise.resolve({ id: 还在的客户 }), searchParams: sp } as never)) } : {}),
    提醒: () => 取提醒项(我),
    盯盘: () => loadWatchlist(dayjs(), { ownerId: 我 }),
    数据页本月: () => 加载复盘(dayjs().startOf("month").toDate(), dayjs().endOf("month").toDate(), "day"),
    导出: () => 导出客户({}),
  };
  const 坏的: string[] = [];
  for (const [名, f] of Object.entries(页)) {
    try { await f(); } catch (e) { 坏的.push(`${名}：${e instanceof Error ? e.message.split("\n").slice(-2).join(" ") : e}`); }
  }
  return 坏的;
}

/* ------------------------------------------------------------------ */

describe("（自检）页面取数真的跑了", () => {
  it("客户列表 page 交给界面的 rows / total 就是库里的数", async () => {
    await 满满的客户();
    const el = (await (await import("@/app/(app)/customers/page")).default({ searchParams: Promise.resolve({}) } as never)) as { props: { rows: unknown[]; total: number } };
    expect([el.props.rows.length, el.props.total]).toEqual([1, 1]);
  });
});

describe("删客户", () => {
  it("清点的数 = 真删掉的数；联系人进未归属；线索留着但不再连着；没有悬空外键", async () => {
    const { c } = await 满满的客户();
    await saveLead({ name: "海川外贸", contact: "赵总", phone: "13700000001", source: "微信", status: "待跟进" });
    const l = await prisma.lead.findFirstOrThrow();
    const 转 = await convertLead(l.id);
    if (!转.ok) throw new Error(转.error);
    const 别人 = await 造客户(我, { name: "别的客户" });
    await saveTask({ customerId: 别人.id, title: "别人的待办" });

    const 清点 = await 删除前清点([c.id]);
    expect(清点).toMatchObject({ 跟进: 2, 商机: 2, 签约: 1, 联系人: 2, 线索: 0 });
    const r = await deleteCustomers([c.id]);
    expect(r).toMatchObject({ ok: true, deleted: 1, 留下联系人: 2 });

    expect(await prisma.followUp.count({ where: { customerId: c.id } })).toBe(0);
    expect(await prisma.followUpSource.count()).toBe(0);
    expect(await prisma.opportunity.count({ where: { customerId: c.id } })).toBe(0);
    expect(await prisma.opportunityClose.count()).toBe(0);
    expect(await prisma.followPlan.count({ where: { customerId: c.id } })).toBe(0);
    expect(await prisma.task.count({ where: { customerId: c.id } })).toBe(0);
    expect(await prisma.contract.count({ where: { customerId: c.id } })).toBe(0);
    expect(await prisma.task.count(), "别人的待办不受影响").toBe(1);
    const 未归属 = await prisma.unassignedContact.findMany({ orderBy: { name: "asc" } });
    expect(未归属.map((u) => [u.name, u.fromCustomerName])).toEqual([["李工", "海川外贸"], ["王总", "海川外贸"]]);
    expect(未归属.find((u) => u.name === "王总")?.phone).toBe("13800000009");
    expect(await 外键体检()).toEqual([]);
  });

  it("删了之后：提醒、逾期、盯盘、数据页、导出、各页取数都不报错，数字跟着少", async () => {
    const { c } = await 满满的客户();
    const 留下的 = await 满满的客户("平川科技");
    const 逾期前 = await 数逾期跟进(prisma, { ownerId: 我 });
    await deleteCustomers([c.id]);
    expect(await 各页取数(留下的.c.id)).toEqual([]);
    expect(await 数逾期跟进(prisma, { ownerId: 我 })).toBe(逾期前 / 2);
    expect((await 取提醒项(我)).every((x) => x.customerId === 留下的.c.id)).toBe(true);
    expect((await 加载复盘(dayjs().startOf("month").toDate(), dayjs().endOf("month").toDate(), "day")).total.amount).toBe(3000);
  });

  it("删的是从线索转来的客户：线索上的「已转化」和「查看客户」不该悬着（C）", async () => {
    await saveLead({ name: "海川外贸", contact: "赵总", phone: "13700000001", source: "微信", status: "待跟进" });
    const l = await prisma.lead.findFirstOrThrow();
    const 转 = await convertLead(l.id);
    if (!转.ok) throw new Error(转.error);
    await deleteCustomers([转.customerId]);
    const 现 = await prisma.lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(现.customerId).toBeNull();
    // 现状：状态还写「已转化」，列表上却又出现「转客户」按钮——两样说法打架
    expect(现.status, "客户删了，线索仍标「已转化」").not.toBe("已转化");
  });

  it("删了转化来的客户，线索可以再转一次（不报「已转化」）", async () => {
    await saveLead({ name: "海川外贸", contact: "赵总", phone: "13700000001", source: "微信", status: "待跟进" });
    const l = await prisma.lead.findFirstOrThrow();
    const 转 = await convertLead(l.id);
    if (!转.ok) throw new Error(转.error);
    await deleteCustomers([转.customerId]);
    expect((await convertLead(l.id)).ok).toBe(true);
  });

  it("导入建的客户被手工删了，再撤销那一批：跳过它、不报错", async () => {
    const { 表头, 数据 } = 成表(解析CSV("姓名,手机号\n甲,13800000001\n乙,13800000002"));
    const w = await 执行导入({ 表头, 数据, 映射: 猜列(表头, 字段表(DEFAULT_BUSINESS)), 重复行: "跳过" }, "a.csv");
    if (!w.ok) throw new Error(w.error);
    await deleteCustomers([(await prisma.customer.findFirstOrThrow({ where: { name: "甲" } })).id]);
    expect(await 撤销批次(w.batchId)).toMatchObject({ ok: true, 删掉: 1, 没动: [] });
  });

  it("移出过的联系人、原客户再被删：未归属那行留着，跟进 id 指向已删的记录也不出错", async () => {
    const { c, 王 } = await 满满的客户();
    await detachContact(王.id);
    await deleteCustomers([c.id]);
    expect(await prisma.unassignedContact.count()).toBe(2);
    expect(await 各页取数()).toEqual([]);
  });
});

describe("删商机 / 联系人", () => {
  it("删商机：跟进还在、只是不再写是哪个商机；结单时刻一起没；撤销后接回", async () => {
    const { c, 年框, 试单 } = await 满满的客户();
    const d = await deleteOpportunities([年框.id, 试单.id]);
    const f = await prisma.followUp.findFirstOrThrow({ where: { content: "聊报价" } });
    expect(f.opportunityId).toBeNull();
    expect(await prisma.opportunityClose.count()).toBe(0);
    expect(await 外键体检()).toEqual([]);
    expect(await 各页取数(c.id)).toEqual([]);
    if (d.ok) await restoreOpportunities(d.快照);
    expect((await prisma.followUp.findFirstOrThrow({ where: { content: "聊报价" } })).opportunityId).toBe(年框.id);
    expect(await prisma.opportunityClose.count(), "赢单那个的结单时刻原样回来").toBe(1);
  });

  it("删联系人：跟进还在、不再写跟谁谈的；撤销后接回、主要联系人还是他", async () => {
    const { c, 王 } = await 满满的客户();
    const d = await deleteContact(王.id);
    expect((await prisma.followUp.findFirstOrThrow({ where: { content: "聊报价" } })).contactId).toBeNull();
    expect(await 各页取数(c.id)).toEqual([]);
    if (!d.ok) throw new Error("x");
    await restoreContact(d.快照);
    expect((await prisma.followUp.findFirstOrThrow({ where: { content: "聊报价" } })).contactId).toBe(王.id);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: 王.id } })).isPrimary).toBe(true);
  });
});

describe("跟进「提醒 / 任务」顺带建的待办", () => {
  it("【B】删掉那条「跟进提醒」：顺带建的待办还在，到点照样提醒、计划页照样算逾期", async () => {
    const c = await 造客户(我);
    const f = await saveFollowUp({ customerId: c.id, type: "REMIND", content: "周五回电", status: "待处理", occurredAt: new Date().toISOString(), dueAt: 昨天() });
    if (!f.ok) throw new Error("x");
    expect(await prisma.task.count()).toBe(1);
    await deleteFollowUp(f.id, c.id);
    expect(await prisma.task.count({ where: { done: false } }), "记录删了，提醒还挂着").toBe(0);
  });

  it("【B】改了「跟进提醒」上的提醒时间：待办的时间没跟着改，到点按旧时间叫", async () => {
    const c = await 造客户(我);
    const 旧 = new Date(Date.now() + 86400000);
    const 新 = new Date(Date.now() + 3 * 86400000);
    const f = await saveFollowUp({ customerId: c.id, type: "REMIND", content: "回电", status: "待处理", occurredAt: new Date().toISOString(), dueAt: 旧.toISOString() });
    if (!f.ok) throw new Error("x");
    await saveFollowUp({ id: f.id, customerId: c.id, type: "REMIND", content: "回电", status: "待处理", occurredAt: new Date().toISOString(), dueAt: 新.toISOString() });
    const t = await prisma.task.findFirstOrThrow();
    expect(t.dueAt?.getTime()).toBe(新.getTime());
  });
});

describe("删渠道 / 线索", () => {
  it("有客户挂着（直接来源或业绩归属）的渠道删不掉，说清几位", async () => {
    const ch = await saveChannel({ name: "小红", phone: null, remark: null, channelOwnerId: 我 });
    if (!ch.ok) throw new Error(ch.error);
    await 造客户(我, { channelId: ch.id, attributionChannelId: ch.id });
    expect(await deleteChannel(ch.id)).toMatchObject({ ok: false });
    const ch2 = await saveChannel({ name: "老周", phone: null, remark: null, channelOwnerId: 我 });
    if (!ch2.ok) throw new Error(ch2.error);
    await 造客户(我, { attributionChannelId: ch2.id });
    expect(await deleteChannel(ch2.id)).toMatchObject({ ok: false });
    expect(await prisma.channel.count()).toBe(2);
  });

  it("没人挂着的渠道删掉后，各页取数正常", async () => {
    const ch = await saveChannel({ name: "小红", phone: null, remark: null, channelOwnerId: 我 });
    if (!ch.ok) throw new Error(ch.error);
    expect(await deleteChannel(ch.id)).toEqual({ ok: true });
    expect(await 各页取数()).toEqual([]);
  });

  it("【B】渠道已在另一个窗口删了，这边点「删除」/「停用」：应说一句，不该抛", async () => {
    const ch = await saveChannel({ name: "小红", phone: null, remark: null, channelOwnerId: 我 });
    if (!ch.ok) throw new Error(ch.error);
    await deleteChannel(ch.id);
    const 删 = await deleteChannel(ch.id).then(() => "ok", (e) => `抛了：${String(e).slice(0, 80)}`);
    const 停 = await toggleChannel(ch.id, false).then(() => "ok", (e) => `抛了：${String(e).slice(0, 80)}`);
    expect({ 删: 删.startsWith("抛了"), 停: 停.startsWith("抛了") }).toEqual({ 删: false, 停: false });
  });

  it("删一条已转化的线索：客户留着，客户页、各页取数正常", async () => {
    await saveLead({ name: "海川外贸", contact: "赵总", phone: "13700000001", source: "微信", status: "待跟进" });
    const l = await prisma.lead.findFirstOrThrow();
    const 转 = await convertLead(l.id);
    if (!转.ok) throw new Error(转.error);
    await deleteLeads([l.id]);
    expect(await prisma.customer.count()).toBe(1);
    expect(await 外键体检()).toEqual([]);
    expect(await 各页取数(转.customerId)).toEqual([]);
  });
});
