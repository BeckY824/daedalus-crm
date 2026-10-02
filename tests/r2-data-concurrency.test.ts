/**
 * 二轮排查（r2-data）· 并发与过期。
 *
 * 桌面端是一个人用，但「两个窗口」「编辑框开着、另一处删了」「手快连点」「提示条上的撤销点晚了」都是真实的。
 * 每一条都调真实的 Server Action。判据分两种：
 *   - 数据不能写坏（重复、丢、错挂）——A 档；
 *   - 失败要「说一句」而不是抛异常（抛出去在界面上多半是按钮转完圈什么都没发生）——B 档。
 * 测出来真坏的保留失败用例，报告见 scratchpad/audit/r2-data.md。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人, 造客户, 结局 } from "./r2-data-helpers";
import { saveCustomer, deleteCustomers, saveContract, patchCustomer } from "@/app/(app)/customers/actions";
import {
  saveFollowUp, deleteFollowUp, restoreFollowUp, saveTask, toggleTask, deleteTask,
  savePlan, deletePlan, completePlan, saveContact, deleteContact, restoreContact,
  detachContact, undoDetachContact,
} from "@/app/(app)/customers/[id]/actions";
import { saveOpportunity, moveStage, setOppStatus, deleteOpportunities, restoreOpportunities } from "@/app/(app)/opportunities/actions";
import { 执行导入, 撤销批次, type 导入方案 } from "@/app/(app)/customers/import-actions";
import { 解析CSV, 成表 } from "@/lib/import/parse";
import { 字段表, 猜列 } from "@/lib/import/fields";
import { DEFAULT_BUSINESS } from "@/lib/business-config";

let 我: string;

beforeEach(async () => {
  await resetDb();
  const u = await 造本人();
  我 = u.id;
  mocks.user = { ...mocks.user, id: u.id };
});
afterAll(async () => { await prisma.$disconnect(); });

const 跟进 = (customerId: string, extra: Record<string, unknown> = {}) =>
  saveFollowUp({ customerId, type: "PHONE", content: "聊了报价", status: "已完成", occurredAt: new Date().toISOString(), ...extra });

const 打开 = async (id: string) => {
  const r = await prisma.customer.findUniqueOrThrow({ where: { id } });
  const base = {
    name: r.name, phone: r.phone, school: r.school, grade: r.grade, major: r.major,
    followStatus: r.followStatus, decisionStatus: r.decisionStatus, expectedSignAt: r.expectedSignAt,
    remark: r.remark, salesOwnerId: r.salesOwnerId, channelId: r.channelId, referrerCustomerId: r.referrerCustomerId,
  };
  return (patch: Record<string, unknown>) =>
    saveCustomer({ id, updatedAt: r.updatedAt.toISOString(), base, ...base, ...patch } as Parameters<typeof saveCustomer>[0]);
};

/* ------------------------------------------------------------------ */

/** savePlan 现在可能回 { ok: false }（那条不在了）：测试里造数时断言一下它成了 */
function 有id<T>(r: T): Extract<T, { ok: true }> {
  if (!(r as { ok?: boolean }).ok) throw new Error("造数失败");
  return r as Extract<T, { ok: true }>;
}

describe("两个窗口同时改同一位客户", () => {
  it("不同字段：两边都留下", async () => {
    const c = await 造客户(我);
    const 窗口1 = await 打开(c.id);
    const 窗口2 = await 打开(c.id);
    expect((await 窗口1({ school: "远山资本" })).ok).toBe(true);
    expect((await 窗口2({ remark: "下周三回电" })).ok).toBe(true);
    const 现 = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect([现.school, 现.remark]).toEqual(["远山资本", "下周三回电"]);
  });

  it("同一字段：后存的被拦下、不盖掉先存的", async () => {
    const c = await 造客户(我);
    const 窗口1 = await 打开(c.id);
    const 窗口2 = await 打开(c.id);
    expect((await 窗口1({ school: "远山资本" })).ok).toBe(true);
    const r = await 窗口2({ school: "平川科技" });
    expect(r.ok).toBe(false);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).school).toBe("远山资本");
  });

  it("编辑框开着，客户在另一个窗口被删：保存说一句，不抛", async () => {
    const c = await 造客户(我);
    const 窗口1 = await 打开(c.id);
    await deleteCustomers([c.id]);
    const r = await 结局(窗口1({ remark: "x" }));
    expect(r.抛了).toBe(false);
    if (!r.抛了) expect(r.值).toMatchObject({ ok: false });
  });

  it("记录页行内改字段时客户已被删：说一句", async () => {
    const c = await 造客户(我);
    await deleteCustomers([c.id]);
    const r = await 结局(patchCustomer(c.id, "remark", "x"));
    expect(r.抛了).toBe(false);
    if (!r.抛了) expect(r.值.ok).toBe(false);
  });
});

describe("编辑框开着时记录在另一处被删了（B：应回一句话，不该抛）", () => {
  it("改一条已被删的跟进记录", async () => {
    const c = await 造客户(我);
    const f = await 跟进(c.id);
    if (!f.ok) throw new Error("造数失败");
    await deleteFollowUp(f.id, c.id);
    const r = await 结局(跟进(c.id, { id: f.id, content: "改了内容" }));
    expect(r.抛了, r.抛了 ? r.错 : "").toBe(false);
  });

  it("改一条已被删的待办", async () => {
    const c = await 造客户(我);
    await saveTask({ customerId: c.id, title: "发报价" });
    const t = await prisma.task.findFirstOrThrow();
    await deleteTask(t.id);
    const r = await 结局(saveTask({ id: t.id, customerId: c.id, title: "发报价（改）" }));
    expect(r.抛了, r.抛了 ? r.错 : "").toBe(false);
  });

  it("改一条已被删的计划", async () => {
    const c = await 造客户(我);
    const p = 有id(await savePlan({ customerId: c.id, subject: "回访", plannedAt: new Date().toISOString(), method: "电话沟通" }));
    await deletePlan(p.id);
    const r = await 结局(savePlan({ id: p.id, customerId: c.id, subject: "回访（改）", plannedAt: new Date().toISOString(), method: "电话沟通" }));
    expect(r.抛了, r.抛了 ? r.错 : "").toBe(false);
  });

  it("改一笔已被删的签约", async () => {
    const c = await 造客户(我);
    const k = await prisma.contract.create({ data: { customerId: c.id, amount: 1000, signedAt: new Date() } });
    await prisma.contract.delete({ where: { id: k.id } });
    const r = await 结局(saveContract({ id: k.id, customerId: c.id, amount: 2000, signedAt: new Date(), remark: null }));
    expect(r.抛了, r.抛了 ? r.错 : "").toBe(false);
  });

  it("客户已被删，这边还在登记签约 / 记跟进 / 加待办 / 排计划", async () => {
    const c = await 造客户(我);
    await deleteCustomers([c.id]);
    const 各个 = {
      签约: await 结局(saveContract({ customerId: c.id, amount: 1000, signedAt: new Date(), remark: null })),
      跟进: await 结局(跟进(c.id)),
      待办: await 结局(saveTask({ customerId: c.id, title: "x" })),
      计划: await 结局(savePlan({ customerId: c.id, subject: "x", plannedAt: new Date().toISOString(), method: "电话沟通" })),
    };
    const 抛的 = Object.entries(各个).filter(([, v]) => v.抛了).map(([k]) => k);
    expect(抛的, `这几样直接抛异常：${抛的.join("、")}`).toEqual([]);
  });
});

describe("完成 / 撤销完成 时那一条已经没了", () => {
  it("计划在另一个窗口删了，这边点「完成」", async () => {
    const c = await 造客户(我);
    const p = 有id(await savePlan({ customerId: c.id, subject: "回访", plannedAt: new Date().toISOString(), method: "电话沟通" }));
    await deletePlan(p.id);
    const r = await 结局(completePlan(p.id));
    expect(r.抛了, r.抛了 ? r.错 : "").toBe(false);
  });

  it("待办在另一个窗口删了，这边勾「完成」/ 点「删除」", async () => {
    const c = await 造客户(我);
    await saveTask({ customerId: c.id, title: "发报价" });
    const t = await prisma.task.findFirstOrThrow();
    await deleteTask(t.id);
    const 勾 = await 结局(toggleTask(t.id, true));
    const 删 = await 结局(deleteTask(t.id));
    expect({ 勾: 勾.抛了, 删: 删.抛了 }).toEqual({ 勾: false, 删: false });
  });

  it("计划完成后撤销：回到未完成", async () => {
    const c = await 造客户(我);
    const p = 有id(await savePlan({ customerId: c.id, subject: "回访", plannedAt: new Date().toISOString(), method: "电话沟通" }));
    await completePlan(p.id);
    await completePlan(p.id, false);
    expect((await prisma.followPlan.findUniqueOrThrow({ where: { id: p.id } })).done).toBe(false);
  });

  it("待办完成后撤销：done 和 doneAt 一起回去", async () => {
    const c = await 造客户(我);
    await saveTask({ customerId: c.id, title: "发报价" });
    const t = await prisma.task.findFirstOrThrow();
    await toggleTask(t.id, true);
    await toggleTask(t.id, false);
    const 现 = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect([现.done, 现.doneAt]).toEqual([false, null]);
  });
});

describe("商机拖阶段 / 改状态后撤销", () => {
  async function 商机(customerId: string, extra: Record<string, unknown> = {}) {
    const r = await saveOpportunity({ name: "年框", customerId, amount: 50000, stage: "方案报价", status: "OPEN", probability: 75, ownerId: 我, ...extra });
    if (!r.ok) throw new Error(r.error);
    return prisma.opportunity.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
  }

  it("拖进赢单成交再撤销：阶段、手填概率、进行中、结单时刻都回去", async () => {
    const c = await 造客户(我);
    const o = await 商机(c.id);
    await moveStage(o.id, "赢单成交");
    expect(await prisma.opportunityClose.count()).toBe(1);
    await moveStage(o.id, "方案报价", 75); // 界面上的撤销就是这么调的（PipelineView 推进(…, 是撤销)）
    const 现 = await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } });
    expect([现.stage, 现.probability, 现.status]).toEqual(["方案报价", 75, "OPEN"]);
    expect(await prisma.opportunityClose.count()).toBe(0);
  });

  it("拖完后商机在另一个窗口被删，再点撤销：说一句", async () => {
    const c = await 造客户(我);
    const o = await 商机(c.id);
    await moveStage(o.id, "谈判审核");
    await deleteOpportunities([o.id]);
    const r = await 结局(moveStage(o.id, "方案报价", 75));
    expect(r.抛了).toBe(false);
    if (!r.抛了) expect(r.值.ok).toBe(false);
  });

  it("标丢单后撤销：阶段和概率原样回来、不留结单时刻", async () => {
    const c = await 造客户(我);
    const o = await 商机(c.id);
    await setOppStatus(o.id, "LOST");
    await setOppStatus(o.id, "OPEN", { stage: "方案报价", probability: 75 });
    const 现 = await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } });
    expect([现.stage, 现.probability, 现.status]).toEqual(["方案报价", 75, "OPEN"]);
    expect(await prisma.opportunityClose.count()).toBe(0);
  });

  it("两个窗口：一边编辑框开着，一边把它拖了阶段，编辑框再保存被拦", async () => {
    const c = await 造客户(我);
    const o = await 商机(c.id);
    const 版本 = o.updatedAt.toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await moveStage(o.id, "谈判审核");
    const r = await saveOpportunity({ id: o.id, 版本, name: "年框（改名）", customerId: c.id, amount: 50000, stage: "方案报价", status: "OPEN", probability: 75, ownerId: 我 });
    expect(r.ok).toBe(false);
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).stage).toBe("谈判审核");
  });
});

describe("删客户之后再点各处的「撤销」", () => {
  it("撤销删跟进 / 撤销移出联系人 / 撤销删商机 / 撤销删联系人：都说一句、不抛、不建出孤儿", async () => {
    const c = await 造客户(我);
    const f = await 跟进(c.id);
    if (!f.ok) throw new Error("x");
    const 删跟进 = await deleteFollowUp(f.id, c.id);
    await saveContact({ customerId: c.id, name: "王总", isPrimary: true });
    await saveContact({ customerId: c.id, name: "李工", isPrimary: false });
    const [王, 李] = await prisma.contact.findMany({ orderBy: { name: "asc" } });
    const 移出 = await detachContact(王.id);
    const 删联系人 = await deleteContact(李.id);
    const o = await saveOpportunity({ name: "x", customerId: c.id, amount: 1, stage: "初步沟通", status: "OPEN", probability: 20, ownerId: 我 });
    expect(o.ok).toBe(true);
    const 删商机 = await deleteOpportunities((await prisma.opportunity.findMany()).map((x) => x.id));

    await deleteCustomers([c.id]);

    const 结果 = {
      跟进: await 结局(restoreFollowUp(删跟进.ok ? 删跟进.快照 : (null as never))),
      移出: await 结局(undoDetachContact(王.id, 移出.ok ? 移出.原来是关键 : false)),
      联系人: await 结局(restoreContact(删联系人.ok ? 删联系人.快照 : (null as never))),
      商机: await 结局(restoreOpportunities(删商机.ok ? 删商机.快照 : (null as never))),
    };
    expect(Object.values(结果).every((r) => !r.抛了)).toBe(true);
    expect(await prisma.followUp.count()).toBe(0);
    expect(await prisma.opportunity.count()).toBe(0);
    expect(await prisma.contact.count()).toBe(0);
  });
});

describe("连点：同一个动作并发调两次（B：第二下应是无事发生或一句话，不该抛）", () => {
  it("删待办连点两下", async () => {
    const c = await 造客户(我);
    await saveTask({ customerId: c.id, title: "x" });
    const t = await prisma.task.findFirstOrThrow();
    const rs = await Promise.all([结局(deleteTask(t.id)), 结局(deleteTask(t.id))]);
    expect(rs.filter((r) => r.抛了).length, "有一下直接抛了").toBe(0);
  });

  it("删计划连点两下", async () => {
    const c = await 造客户(我);
    const p = 有id(await savePlan({ customerId: c.id, subject: "x", plannedAt: new Date().toISOString(), method: "电话沟通" }));
    const rs = await Promise.all([结局(deletePlan(p.id)), 结局(deletePlan(p.id))]);
    expect(rs.filter((r) => r.抛了).length).toBe(0);
  });

  it("删联系人连点两下", async () => {
    const c = await 造客户(我);
    await saveContact({ customerId: c.id, name: "王总", isPrimary: false });
    const k = await prisma.contact.findFirstOrThrow();
    const rs = await Promise.all([结局(deleteContact(k.id)), 结局(deleteContact(k.id))]);
    expect(rs.filter((r) => r.抛了).length).toBe(0);
  });

  it("「只移出」联系人连点两下", async () => {
    const c = await 造客户(我);
    await saveContact({ customerId: c.id, name: "王总", isPrimary: false });
    const k = await prisma.contact.findFirstOrThrow();
    const rs = await Promise.all([结局(detachContact(k.id)), 结局(detachContact(k.id))]);
    expect(rs.filter((r) => r.抛了).length).toBe(0);
    expect(await prisma.unassignedContact.count()).toBe(1);
  });

  it("删一位带联系人的客户，两个窗口几乎同时点了删除", async () => {
    const c = await 造客户(我);
    await saveContact({ customerId: c.id, name: "王总", isPrimary: true });
    const rs = await Promise.all([结局(deleteCustomers([c.id])), 结局(deleteCustomers([c.id]))]);
    expect(rs.filter((r) => r.抛了).length, rs.map((r) => (r.抛了 ? r.错 : "")).join(" | ")).toBe(0);
    expect(await prisma.customer.count()).toBe(0);
    expect(await prisma.unassignedContact.count(), "联系人留在未归属，而且只留一份").toBe(1);
  });

  it("撤销删跟进连点两下", async () => {
    const c = await 造客户(我);
    const f = await 跟进(c.id);
    if (!f.ok) throw new Error("x");
    const d = await deleteFollowUp(f.id, c.id);
    if (!d.ok) throw new Error("x");
    const rs = await Promise.all([结局(restoreFollowUp(d.快照)), 结局(restoreFollowUp(d.快照))]);
    expect(rs.filter((r) => r.抛了).length).toBe(0);
    expect(await prisma.followUp.count()).toBe(1);
  });

  it("撤销删商机连点两下", async () => {
    const c = await 造客户(我);
    await saveOpportunity({ name: "x", customerId: c.id, amount: 1, stage: "初步沟通", status: "OPEN", probability: 20, ownerId: 我 });
    const d = await deleteOpportunities((await prisma.opportunity.findMany()).map((x) => x.id));
    if (!d.ok) throw new Error(d.error);
    const rs = await Promise.all([结局(restoreOpportunities(d.快照)), 结局(restoreOpportunities(d.快照))]);
    expect(rs.filter((r) => r.抛了).length).toBe(0);
    expect(await prisma.opportunity.count()).toBe(1);
  });

  it("撤销删联系人连点两下", async () => {
    const c = await 造客户(我);
    await saveContact({ customerId: c.id, name: "王总", isPrimary: false });
    const d = await deleteContact((await prisma.contact.findFirstOrThrow()).id);
    if (!d.ok) throw new Error("x");
    const rs = await Promise.all([结局(restoreContact(d.快照)), 结局(restoreContact(d.快照))]);
    expect(rs.filter((r) => r.抛了).length).toBe(0);
    expect(await prisma.contact.count()).toBe(1);
  });

  it("撤销导入批次连点两下：不抛、只撤一次", async () => {
    const 方案 = 造方案("姓名,手机号\n张三,13800000001\n李四,13800000002");
    const w = await 执行导入(方案, "a.csv");
    if (!w.ok) throw new Error(w.error);
    const rs = await Promise.all([结局(撤销批次(w.batchId)), 结局(撤销批次(w.batchId))]);
    expect(rs.filter((r) => r.抛了).length).toBe(0);
    expect(await prisma.customer.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "import-revert" } }), "撤销留痕只该有一条").toBe(1);
  });
});

describe("两个窗口几乎同时提交同一件事（服务端没有闸门时会写出重复）", () => {
  it("同一位客户、同一笔金额、同一天的签约，两边都没勾「确认不是重复」：只该进一笔", async () => {
    const c = await 造客户(我);
    const 录 = () => saveContract({ customerId: c.id, amount: 86000, signedAt: new Date(), remark: null });
    await Promise.all([录(), 录()]);
    expect(await prisma.contract.count(), "同额同日的第二笔应被查重拦下，业绩翻倍是最难发现的那类错").toBe(1);
  });

  it("同一个号码同时新建两次：库里只该有一位", async () => {
    const 建 = () => saveCustomer({
      name: "王强", phone: "13800001111", school: null, grade: null, major: null, followStatus: "待跟进",
      decisionStatus: "了解中", expectedSignAt: null, remark: null, salesOwnerId: 我, channelId: null, referrerCustomerId: null,
    });
    await Promise.all([建(), 建()]);
    expect(await prisma.customer.count({ where: { phone: "13800001111" } })).toBe(1);
  });

  it("同一份表在两个窗口同时导入：同一个号码不该建出两位", async () => {
    const csv = "姓名,手机号\n张三,13800000001\n李四,13800000002\n王五,13800000003";
    await Promise.all([执行导入(造方案(csv), "a.csv"), 执行导入(造方案(csv), "a.csv")]);
    const 每号 = await prisma.customer.groupBy({ by: ["phone"], _count: { _all: true } });
    expect(每号.filter((x) => x._count._all > 1).map((x) => x.phone)).toEqual([]);
  });
});

describe("没有版本闸门的几样：两个窗口改同一条，后存的整条盖掉先存的（B）", () => {
  it("同一条跟进：窗口 1 改内容、窗口 2 改状态，窗口 1 的内容被悄悄盖回去", async () => {
    const c = await 造客户(我);
    const f = await 跟进(c.id, { status: "待处理", type: "TASK" });
    if (!f.ok) throw new Error("x");
    const 原 = await prisma.followUp.findUniqueOrThrow({ where: { id: f.id } });
    const 基 = { customerId: c.id, type: 原.type, title: 原.title, content: 原.content, status: 原.status, occurredAt: 原.occurredAt.toISOString() };
    await saveFollowUp({ ...基, id: f.id, content: "窗口1：客户要分三期" });
    const r2 = await saveFollowUp({ ...基, id: f.id, status: "已完成" });
    const 现 = await prisma.followUp.findUniqueOrThrow({ where: { id: f.id } });
    // 要么两边合并，要么第二次被拦下说一句；不能静默丢掉窗口 1 的内容
    expect(现.content === "窗口1：客户要分三期" || r2.ok === false, "窗口 1 改的内容被整条覆盖、没有任何提示").toBe(true);
  });

  it("同一条计划：窗口 1 改时间、窗口 2 改主题，窗口 1 的时间被盖回去", async () => {
    const c = await 造客户(我);
    const t0 = new Date(Date.now() + 86400000).toISOString();
    const p = 有id(await savePlan({ customerId: c.id, subject: "回访", plannedAt: t0, method: "电话沟通" }));
    const 新时间 = new Date(Date.now() + 3 * 86400000).toISOString();
    await savePlan({ id: p.id, customerId: c.id, subject: "回访", plannedAt: 新时间, method: "电话沟通" });
    const r2 = 有id(await savePlan({ id: p.id, customerId: c.id, subject: "回访：带报价单", plannedAt: t0, method: "电话沟通" }));
    const 现 = await prisma.followPlan.findUniqueOrThrow({ where: { id: p.id } });
    expect(现.plannedAt.toISOString() === 新时间 || (r2 as { ok: boolean }).ok === false, "窗口 1 改的时间被静默覆盖").toBe(true);
  });
});

function 造方案(csv: string): 导入方案 {
  const { 表头, 数据 } = 成表(解析CSV(csv));
  return { 表头, 数据, 映射: 猜列(表头, 字段表(DEFAULT_BUSINESS)), 重复行: "跳过" };
}
