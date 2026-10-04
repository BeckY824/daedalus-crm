/**
 * 上线前第 2 期 2a · 删除矩阵（「连带删除联系人」这一类，用户最在意的）。
 *
 * 每一行是一种删法，每一列是删完之后人会去看的一处：
 *   联系人页 / 跟进页 / 商机管道 / 签约业绩（数据页）/ 待办计划 / 公海 / 线索页 / 渠道页 / 首页数字，外加「撤销后」。
 * 每一列都取**真实页面交给界面的那份数据**（page.tsx 服务端取数跑一遍，View 换成空壳），首页数字用首页同一组函数。
 *
 * 断言方式：删之前看一遍、删之后看一遍，算出「哪几列、多了什么少了什么」，整份 toEqual——
 * 写出来的列必须这么变，**没写出来的列必须一点没变**。能撤销的，撤完再看一遍必须和删之前一模一样。
 * 矩阵表（每格钉在哪条用例上）见 ~/CRM/上线前测试分期/删除矩阵.md。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user, getCurrentUser: async () => mocks.user }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, redirect: () => { throw new Error("REDIRECT"); } }));
for (const m of [
  "@/app/(app)/follow-ups/FollowUpsView", "@/app/(app)/follow-ups/plans/PlansView",
  "@/app/(app)/opportunities/pipeline/PipelineView", "@/app/(app)/contacts/ContactsView", "@/app/(app)/leads/LeadsView",
  "@/app/(app)/channels/ChannelsView", "@/app/(app)/customers/CustomersView",
]) vi.doMock(m, () => ({ default: () => null }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人 } from "./r2-data-helpers";
import { deleteCustomers, saveContract, deleteContract } from "@/app/(app)/customers/actions";
import {
  saveFollowUp, deleteFollowUp, restoreFollowUp, savePlan, deletePlan, saveTask, deleteTask,
  saveContact, detachContact, undoDetachContact, saveUnassignedContact, deleteContact, deleteUnassignedContact, restoreContact,
} from "@/app/(app)/customers/[id]/actions";
import { saveOpportunity, deleteOpportunities, restoreOpportunities } from "@/app/(app)/opportunities/actions";
import { saveLead, convertLead, deleteLeads } from "@/app/(app)/leads/actions";
import { saveChannel, deleteChannel } from "@/app/(app)/channels/actions";
import { 放进公海 } from "@/app/(app)/customers/pool-actions";
import { 执行导入, 撤销批次 } from "@/app/(app)/customers/import-actions";
import { 解析CSV, 成表 } from "@/lib/import/parse";
import { 字段表, 猜列 } from "@/lib/import/fields";
import { DEFAULT_BUSINESS } from "@/lib/business-config";
import { 取提醒项 } from "@/lib/reminders-db";
import { 算提醒 } from "@/lib/reminders";
import { 数逾期跟进 } from "@/lib/overdue";
import { 加载复盘 } from "@/app/(app)/overview/data";
import { dayjs } from "@/lib/utils";

let 我: string;
beforeEach(async () => {
  await resetDb();
  我 = (await 造本人()).id;
  mocks.user = { ...mocks.user, id: 我 };
});
afterAll(async () => { await prisma.$disconnect(); });

const 昨天 = () => new Date(Date.now() - 86400000).toISOString();
const 本月某天 = () => dayjs().startOf("month").add(1, "hour").toDate();

/* ------------------------------ 造数 ------------------------------ */

/**
 * 一位「什么都挂着」的客户：联系人 2（王总是关键）、商机 2（试单是签约时顺手赢下的）、
 * 跟进 2（一条指着王总和年框、带 AI 原文；一条是提醒，顺带建了待办）、计划 1、待办 1（都逾期）、签约 1。
 */
async function 挂满(id: string, 名: string, 号尾: string, 金额: number) {
  await saveContact({ customerId: id, name: `${名}王总`, phone: `1380000${号尾}9`, isPrimary: true });
  await saveContact({ customerId: id, name: `${名}李工`, isPrimary: false });
  const 王 = await prisma.contact.findFirstOrThrow({ where: { name: `${名}王总` } });
  await saveOpportunity({ name: `${名}年框`, customerId: id, amount: 50000, stage: "方案报价", status: "OPEN", probability: 60, ownerId: 我 });
  await saveOpportunity({ name: `${名}试单`, customerId: id, amount: 金额, stage: "需求确认", status: "OPEN", probability: 40, ownerId: 我 });
  const 年框 = await prisma.opportunity.findFirstOrThrow({ where: { name: `${名}年框` } });
  const 试单 = await prisma.opportunity.findFirstOrThrow({ where: { name: `${名}试单` } });
  const 聊 = await saveFollowUp({ customerId: id, type: "PHONE", content: `${名}聊报价`, status: "已完成", occurredAt: 昨天(), contactId: 王.id, opportunityId: 年框.id, sourceText: "原话" });
  const 提醒 = await saveFollowUp({ customerId: id, type: "REMIND", content: `${名}提醒回电`, status: "待处理", occurredAt: new Date().toISOString(), dueAt: 昨天() });
  const 计划 = await savePlan({ customerId: id, subject: `${名}回访`, plannedAt: 昨天(), method: "电话沟通" });
  await saveTask({ customerId: id, title: `${名}发合同`, dueAt: 昨天() });
  const 签 = await saveContract({ customerId: id, amount: 金额, signedAt: 本月某天(), remark: null, 联动: { 赢单: [试单.id], 完成计划: [], 完成待办: [] } });
  if (!聊.ok || !提醒.ok || !计划.ok || !签.ok) throw new Error("造数失败");
  const 签约 = await prisma.contract.findFirstOrThrow({ where: { customerId: id } });
  const 待办 = await prisma.task.findFirstOrThrow({ where: { title: `${名}发合同` } });
  return { 王, 年框, 试单, 聊: 聊.id, 提醒: 提醒.id, 计划: 计划.id, 待办: 待办.id, 签约: 签约.id };
}

async function 造客户(名: string, 号尾: string) {
  return prisma.customer.create({ data: { name: 名, phone: `1390000${号尾}`, salesOwnerId: 我 } });
}

/**
 * 一整个工作区：
 *   甲（从线索「甲线索」转来、挂满）、乙（挂满）、丙（挂满）、丁（在公海里，一位联系人一条跟进）、
 *   戊（渠道「老周」带来的，什么都没挂）；另有没人挂着的渠道「空渠道」、没转化的线索「待跟进线索」。
 */
async function 造全套() {
  await saveLead({ name: "甲", contact: "", phone: "13700000001", source: "微信", status: "待跟进" });
  const 线索 = await prisma.lead.findFirstOrThrow({ where: { name: "甲" } });
  const 转 = await convertLead(线索.id);
  if (!转.ok) throw new Error(转.error);
  await prisma.lead.update({ where: { id: 线索.id }, data: { name: "甲线索" } });
  await saveLead({ name: "待跟进线索", contact: "孙总", phone: "13700000002", source: "微信", status: "待跟进" });
  const 甲 = await prisma.customer.findUniqueOrThrow({ where: { id: 转.customerId } });
  const 乙 = await 造客户("乙", "0002");
  const 丙 = await 造客户("丙", "0003");
  const 丁 = await 造客户("丁", "0004");
  const 老周 = await saveChannel({ name: "老周", phone: null, remark: null, channelOwnerId: 我 });
  const 空渠道 = await saveChannel({ name: "空渠道", phone: null, remark: null, channelOwnerId: 我 });
  if (!老周.ok || !空渠道.ok) throw new Error("造数失败");
  const 戊 = await prisma.customer.create({ data: { name: "戊", phone: "13900000005", salesOwnerId: 我, channelId: 老周.id, attributionChannelId: 老周.id } });
  const 甲的 = await 挂满(甲.id, "甲", "1", 3000);
  const 乙的 = await 挂满(乙.id, "乙", "2", 2000);
  const 丙的 = await 挂满(丙.id, "丙", "3", 1000);
  await saveContact({ customerId: 丁.id, name: "丁太太", isPrimary: true });
  await saveFollowUp({ customerId: 丁.id, type: "PHONE", content: "丁没接", status: "已完成", occurredAt: 昨天() });
  expect((await 放进公海([丁.id])).ok).toBe(true);
  return { 甲, 乙, 丙, 丁, 戊, 线索, 甲的, 乙的, 丙的, 老周: 老周.id, 空渠道: 空渠道.id };
}

/* ------------------------------ 看一遍 ------------------------------ */

type 页面 = { props: Record<string, unknown> };
const sp = (x: Record<string, string> = {}) => ({ searchParams: Promise.resolve(x) }) as never;
const 行 = (el: unknown, key = "rows") => (el as 页面).props[key] as Record<string, unknown>[];

/** 每一列都写成「客户名|内容」，排好序；数字列直接是数 */
async function 看一遍() {
  const [联系人, 跟进, 管道, 计划页, 公海, 线索, 渠道] = await Promise.all([
    import("@/app/(app)/contacts/page").then((m) => m.default(sp())),
    import("@/app/(app)/follow-ups/page").then((m) => m.default(sp())),
    import("@/app/(app)/opportunities/pipeline/page").then((m) => m.default()),
    import("@/app/(app)/follow-ups/plans/page").then((m) => m.default(sp())),
    import("@/app/(app)/customers/page").then((m) => m.default(sp({ pool: "1" }))),
    import("@/app/(app)/leads/page").then((m) => m.default(sp())),
    import("@/app/(app)/channels/page").then((m) => m.default()),
  ]);
  const 复盘 = await 加载复盘(dayjs().startOf("month").toDate(), dayjs().endOf("month").toDate(), "day");
  const 提醒 = 算提醒(await 取提醒项(我));
  const 本月 = await prisma.contract.findMany({ where: { signedAt: { gte: dayjs().startOf("month").toDate(), lt: dayjs().endOf("month").toDate() } }, select: { amount: true } });
  const 排 = (xs: string[]) => xs.sort();
  return {
    联系人页: 排(行(联系人).map((r) => (r.未归属 ? `未归属|${r.name}（原${r.原来}）` : `${r.customerName}|${r.name}${r.isPrimary ? "★" : ""}`))),
    跟进页: 排(行(跟进).map((r) => `${r.customerName}|${r.content}|跟${r.contactName ?? "—"}`)),
    商机管道: 排(行(管道).map((r) => `${r.customerName}|${r.name}|${r.status}|${r.stage}`)),
    签约业绩: { 笔数: 复盘.total.count, 金额: 复盘.total.amount },
    待办计划: 排([
      ...行(计划页, "plans").map((r) => `${r.customerName}|计划|${r.subject}`),
      ...行(计划页, "tasks").map((r) => `${r.customerName}|待办|${r.title}`),
    ]),
    公海: 排(行(公海).map((r) => String(r.name))),
    线索页: 排(行(线索).map((r) => `${r.name}|${r.status}|${r.customerId ? "连着客户" : "—"}`)),
    渠道页: 排(行(渠道).map((r) => `${r.name}|直接${r.directCount}`)),
    首页: {
      客户数: await prisma.customer.count(),
      逾期: await 数逾期跟进(prisma, { ownerId: 我 }),
      今天要跟: 提醒.逾期 + 提醒.今天,
      本月签约: 本月.reduce((s, c) => s + c.amount, 0),
    },
  };
}
type 一遍 = Awaited<ReturnType<typeof 看一遍>>;

/** 两遍之间哪几列变了：清单列写「少了 / 多了」，数字列写差值。没变的列不出现 */
function 变化(前: 一遍, 后: 一遍) {
  const 出: Record<string, unknown> = {};
  for (const k of Object.keys(前) as (keyof 一遍)[]) {
    const a = 前[k], b = 后[k];
    if (Array.isArray(a) && Array.isArray(b)) {
      const 少 = a.filter((x) => !b.includes(x));
      const 多 = b.filter((x) => !a.includes(x));
      if (少.length || 多.length) 出[k] = { 少, 多 };
    } else {
      const 差: Record<string, number> = {};
      for (const [kk, v] of Object.entries(a as Record<string, number>)) {
        const d = (b as Record<string, number>)[kk] - v;
        if (d) 差[kk] = d;
      }
      if (Object.keys(差).length) 出[k] = 差;
    }
  }
  return 出;
}

/** 某几位客户在某一列里的全部条目（「客户名|」开头的） */
const 属于 = (列: string[], ...名: string[]) => 列.filter((x) => 名.some((n) => x.startsWith(`${n}|`)));

/* ------------------------------ 矩阵 ------------------------------ */

describe("删除矩阵（2a）：每一种删法 × 每一处看到的", () => {
  it("（自检）造出来的工作区每一列都有东西，不然「没变」证明不了什么", async () => {
    await 造全套();
    const 看 = await 看一遍();
    expect(看.联系人页.length).toBe(7);
    expect(属于(看.跟进页, "甲")).toHaveLength(2);
    expect(属于(看.商机管道, "甲")).toEqual(["甲|甲年框|OPEN|方案报价", "甲|甲试单|WON|赢单成交"]);
    expect(看.签约业绩).toEqual({ 笔数: 3, 金额: 6000 });
    expect(属于(看.待办计划, "甲").length).toBe(3);
    expect(看.公海).toEqual(["丁"]);
    expect(看.线索页).toEqual(["待跟进线索|待跟进|—", "甲线索|已转化|连着客户"]);
    expect(看.渠道页).toEqual(["空渠道|直接0", "老周|直接1"]);
    expect(看.首页).toEqual({ 客户数: 5, 逾期: 9, 今天要跟: 9, 本月签约: 6000 });
  });

  it("删客户（单个）：甲的联系人进未归属；跟进、商机、签约、待办计划全没；线索退回跟进中；公海、渠道不动；首页跟着少", async () => {
    const w = await 造全套();
    const 前 = await 看一遍();
    expect(await deleteCustomers([w.甲.id])).toMatchObject({ ok: true, deleted: 1, 留下联系人: 2 });
    const 后 = await 看一遍();
    expect(变化(前, 后)).toEqual({
      联系人页: { 少: ["甲|甲李工", "甲|甲王总★"], 多: ["未归属|甲李工（原甲）", "未归属|甲王总（原甲）"] },
      跟进页: { 少: 属于(前.跟进页, "甲"), 多: [] },
      商机管道: { 少: 属于(前.商机管道, "甲"), 多: [] },
      签约业绩: { 笔数: -1, 金额: -3000 },
      待办计划: { 少: 属于(前.待办计划, "甲"), 多: [] },
      线索页: { 少: ["甲线索|已转化|连着客户"], 多: ["甲线索|跟进中|—"] },
      首页: { 客户数: -1, 逾期: -3, 今天要跟: -3, 本月签约: -3000 },
    });
    // 撤销后：删客户不能撤销（确认框写「删除后不能恢复」，e2e/delete-customer.spec.ts 钉着）
  });

  it("删客户（单个，在公海里的那位）：公海那一列少了他，联系人进未归属", async () => {
    const w = await 造全套();
    const 前 = await 看一遍();
    expect(await deleteCustomers([w.丁.id])).toMatchObject({ ok: true, deleted: 1, 留下联系人: 1 });
    expect(变化(前, await 看一遍())).toEqual({
      联系人页: { 少: ["丁|丁太太★"], 多: ["未归属|丁太太（原丁）"] },
      跟进页: { 少: ["丁|丁没接|跟—"], 多: [] },
      公海: { 少: ["丁"], 多: [] },
      首页: { 客户数: -1 },
    });
    expect(await prisma.customerPool.count(), "公海那一行跟着没，不留孤儿").toBe(0);
  });

  it("删客户（批量 3 位：甲、乙、公海里的丁）：三位的东西一起走，丙、戊一点不动", async () => {
    const w = await 造全套();
    const 前 = await 看一遍();
    expect(await deleteCustomers([w.甲.id, w.乙.id, w.丁.id])).toMatchObject({ ok: true, deleted: 3, 留下联系人: 5 });
    expect(变化(前, await 看一遍())).toEqual({
      联系人页: {
        少: ["丁|丁太太★", "乙|乙李工", "乙|乙王总★", "甲|甲李工", "甲|甲王总★"],
        多: ["未归属|丁太太（原丁）", "未归属|乙李工（原乙）", "未归属|乙王总（原乙）", "未归属|甲李工（原甲）", "未归属|甲王总（原甲）"],
      },
      跟进页: { 少: 属于(前.跟进页, "甲", "乙", "丁"), 多: [] },
      商机管道: { 少: 属于(前.商机管道, "甲", "乙"), 多: [] },
      签约业绩: { 笔数: -2, 金额: -5000 },
      待办计划: { 少: 属于(前.待办计划, "甲", "乙"), 多: [] },
      公海: { 少: ["丁"], 多: [] },
      线索页: { 少: ["甲线索|已转化|连着客户"], 多: ["甲线索|跟进中|—"] },
      首页: { 客户数: -3, 逾期: -6, 今天要跟: -6, 本月签约: -5000 },
    });
  });

  it("客户详情里删联系人 → 只移出：联系人页写未归属，跟进留着只是不写跟谁；别的列不动；撤销后一模一样", async () => {
    const w = await 造全套();
    const 前 = await 看一遍();
    const r = await detachContact(w.甲的.王.id);
    if (!r.ok) throw new Error(r.error);
    expect(变化(前, await 看一遍())).toEqual({
      联系人页: { 少: ["甲|甲王总★"], 多: ["未归属|甲王总（原甲）"] },
      跟进页: { 少: ["甲|甲聊报价|跟甲王总"], 多: ["甲|甲聊报价|跟—"] },
    });
    expect(await undoDetachContact(w.甲的.王.id, r.原来是关键)).toEqual({ ok: true });
    expect(await 看一遍(), "撤销后各处和移出之前一模一样（关键联系人、跟谁谈的都回来）").toEqual(前);
  });

  it("客户详情里删联系人 → 彻底删除：联系人页没了他，跟进留着；撤销后一模一样", async () => {
    const w = await 造全套();
    const 前 = await 看一遍();
    const r = await deleteContact(w.甲的.王.id);
    if (!r.ok) throw new Error(r.error);
    expect(变化(前, await 看一遍())).toEqual({
      联系人页: { 少: ["甲|甲王总★"], 多: [] },
      跟进页: { 少: ["甲|甲聊报价|跟甲王总"], 多: ["甲|甲聊报价|跟—"] },
    });
    expect(await restoreContact(r.快照)).toMatchObject({ ok: true });
    expect(await 看一遍()).toEqual(前);
  });

  it("联系人页上彻底删除一位未归属的人（删客户留下的）：只少他一个；撤销后一模一样", async () => {
    const w = await 造全套();
    await deleteCustomers([w.丁.id]);
    const 前 = await 看一遍();
    const r = await deleteUnassignedContact((await prisma.unassignedContact.findFirstOrThrow()).id);
    if (!r.ok) throw new Error(r.error);
    expect(变化(前, await 看一遍())).toEqual({ 联系人页: { 少: ["未归属|丁太太（原丁）"], 多: [] } });
    expect(await restoreContact(r.快照)).toMatchObject({ ok: true });
    expect(await 看一遍()).toEqual(前);
  });

  it("未归属联系人挂回原客户：跟进重新写跟他谈的，各处回到移出前（只是不再是关键联系人）", async () => {
    const w = await 造全套();
    const 前 = await 看一遍();
    await detachContact(w.甲的.王.id);
    expect(await saveUnassignedContact({ id: w.甲的.王.id, name: "甲王总", phone: "13800001009", customerId: w.甲.id, isPrimary: false })).toMatchObject({ ok: true, 挂到: "甲" });
    expect(变化(前, await 看一遍())).toEqual({ 联系人页: { 少: ["甲|甲王总★"], 多: ["甲|甲王总"] } });
  });

  it("未归属联系人挂到别人（乙）名下：联系人页挂到乙，甲那条跟进不跟过去；别的列不动", async () => {
    const w = await 造全套();
    const 前 = await 看一遍();
    await detachContact(w.甲的.王.id);
    expect(await saveUnassignedContact({ id: w.甲的.王.id, name: "甲王总", phone: "13800001009", customerId: w.乙.id, isPrimary: false })).toMatchObject({ ok: true, 挂到: "乙" });
    expect(变化(前, await 看一遍())).toEqual({
      联系人页: { 少: ["甲|甲王总★"], 多: ["乙|甲王总"] },
      跟进页: { 少: ["甲|甲聊报价|跟甲王总"], 多: ["甲|甲聊报价|跟—"] },
    });
  });

  it("删商机：只有管道少了它，跟进、签约、首页不动；撤销后一模一样", async () => {
    const w = await 造全套();
    const 前 = await 看一遍();
    const r = await deleteOpportunities([w.甲的.年框.id, w.甲的.试单.id]);
    if (!r.ok) throw new Error(r.error);
    expect(变化(前, await 看一遍())).toEqual({ 商机管道: { 少: 属于(前.商机管道, "甲"), 多: [] } });
    await restoreOpportunities(r.快照);
    expect(await 看一遍()).toEqual(前);
  });

  it("删跟进（普通一条）：只有跟进页少了它；撤销后一模一样", async () => {
    const w = await 造全套();
    const 前 = await 看一遍();
    const r = await deleteFollowUp(w.甲的.聊, w.甲.id);
    if (!r.ok) throw new Error(r.error);
    expect(变化(前, await 看一遍())).toEqual({ 跟进页: { 少: ["甲|甲聊报价|跟甲王总"], 多: [] } });
    expect(await restoreFollowUp(r.快照)).toEqual({ ok: true });
    expect(await 看一遍()).toEqual(前);
  });

  it("删跟进（顺带建了待办的提醒）：跟进页、待办计划、首页逾期一起少；撤销后一模一样", async () => {
    const w = await 造全套();
    const 前 = await 看一遍();
    const r = await deleteFollowUp(w.甲的.提醒, w.甲.id);
    if (!r.ok) throw new Error(r.error);
    const 变 = 变化(前, await 看一遍()) as { 待办计划: { 少: string[] } };
    expect(变).toEqual({
      跟进页: { 少: ["甲|甲提醒回电|跟—"], 多: [] },
      待办计划: { 少: [expect.stringMatching(/^甲\|待办\|/)], 多: [] },
      首页: { 逾期: -1, 今天要跟: -1 },
    });
    expect(变.待办计划.少[0]).not.toBe("甲|待办|甲发合同");
    expect(await restoreFollowUp(r.快照)).toEqual({ ok: true });
    expect(await 看一遍()).toEqual(前);
  });

  it("删签约（登记时顺手赢下了试单）：签约业绩、首页本月签约少；试单在管道里退回进行中；别的不动", async () => {
    const w = await 造全套();
    const 前 = await 看一遍();
    expect(await deleteContract(w.甲的.签约, w.甲.id, null)).toMatchObject({ ok: true, remaining: 0, 退回商机: 1 });
    expect(变化(前, await 看一遍())).toEqual({
      商机管道: { 少: ["甲|甲试单|WON|赢单成交"], 多: ["甲|甲试单|OPEN|需求确认"] },
      签约业绩: { 笔数: -1, 金额: -3000 },
      首页: { 本月签约: -3000 },
    });
    // 撤销后：删签约不能撤销（RecordView 弹框里问退回到哪一档，删完不给撤销）
  });

  it("删待办 / 删计划：只有待办计划和首页逾期少；别的不动", async () => {
    const w = await 造全套();
    const 前 = await 看一遍();
    expect(await deleteTask(w.甲的.待办)).toEqual({ ok: true });
    expect(await deletePlan(w.甲的.计划)).toEqual({ ok: true });
    expect(变化(前, await 看一遍())).toEqual({
      待办计划: { 少: ["甲|待办|甲发合同", "甲|计划|甲回访"], 多: [] },
      首页: { 逾期: -2, 今天要跟: -2 },
    });
    // 撤销后：删待办 / 计划是就地确认、不给撤销（RecordView / PlansView「删除这条？」）
  });

  it("删渠道：没人挂着的删掉只少渠道页一行；有客户挂着的拦下、哪一列都不变", async () => {
    const w = await 造全套();
    const 前 = await 看一遍();
    expect(await deleteChannel(w.老周)).toMatchObject({ ok: false, error: expect.stringContaining("1 名客户") });
    expect(await 看一遍()).toEqual(前);
    expect(await deleteChannel(w.空渠道)).toEqual({ ok: true });
    expect(变化(前, await 看一遍())).toEqual({ 渠道页: { 少: ["空渠道|直接0"], 多: [] } });
  });

  it("删线索（已转化的那条）：只少线索页一行，转出来的客户和他的一切都在", async () => {
    const w = await 造全套();
    const 前 = await 看一遍();
    expect(await deleteLeads([w.线索.id])).toEqual({ ok: true, deleted: 1 });
    expect(变化(前, await 看一遍())).toEqual({ 线索页: { 少: ["甲线索|已转化|连着客户"], 多: [] } });
  });

  it("撤销导入批次：导进来的两位撤掉后，各处和导入之前一模一样", async () => {
    await 造全套();
    const 前 = await 看一遍();
    const { 表头, 数据 } = 成表(解析CSV("姓名,手机号\n导入甲,13600000001\n导入乙,13600000002"));
    const w = await 执行导入({ 表头, 数据, 映射: 猜列(表头, 字段表(DEFAULT_BUSINESS)), 重复行: "跳过" }, "a.csv");
    if (!w.ok) throw new Error(w.error);
    expect(变化(前, await 看一遍())).toEqual({ 首页: { 客户数: 2 } });
    expect(await 撤销批次(w.batchId)).toMatchObject({ ok: true, 删掉: 2, 没动: [] });
    expect(await 看一遍()).toEqual(前);
  });
});
