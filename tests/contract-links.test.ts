/**
 * 签约和赢单打通（2026-09-28 审查 S3），以及丢单的撤销（S7）。
 *
 * 原来登记了 ¥86,000 的签约，商机还挂在「方案报价」、照样算进在谈金额，
 * 逾期计划也还在首页催「先处理」。现在登记签约的弹窗把这几样列出来默认勾上，
 * 服务端**只照勾选的做**。这一组钉的就是这句话的两半：勾了就动，不勾就不动；
 * 以及只动属于这位客户、还没收尾的——id 是从浏览器来的。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { saveContract, listContractLinks } from "@/app/(app)/customers/actions";
import { setOppStatus } from "@/app/(app)/opportunities/actions";

let jia: { id: string };

beforeEach(async () => {
  await resetDb();
  jia = await prisma.user.create({ data: { email: "jia", name: "甲", title: "销售", role: "ADMIN", password: "x" } });
  mocks.user = { id: jia.id, name: "甲", email: "jia", role: "ADMIN", title: "管理员", avatar: null };
});
afterAll(async () => { await prisma.$disconnect(); });

/** 一位在谈的客户：一个进行中的商机、一条没做的计划、一条没做的待办 */
async function 在谈的(name = "周明远") {
  const c = await prisma.customer.create({ data: { name, phone: "", salesOwnerId: jia.id, followStatus: "意向较高" } });
  const o = await prisma.opportunity.create({ data: { name: `${name}的单`, customerId: c.id, amount: 86000, stage: "方案报价", probability: 60, ownerId: jia.id } });
  const p = await prisma.followPlan.create({ data: { customerId: c.id, subject: "发二版阶梯报价", plannedAt: new Date(2026, 8, 24), ownerId: jia.id } });
  const t = await prisma.task.create({ data: { customerId: c.id, title: "算一版阶梯价", ownerId: jia.id } });
  return { c, o, p, t };
}

const 今天 = () => new Date(2026, 8, 28, 10, 0, 0);

describe("登记签约时顺手收尾", () => {
  it("弹窗列的是这位客户进行中的商机、没做完的计划和待办", async () => {
    const { c, o, p, t } = await 在谈的();
    await prisma.opportunity.create({ data: { name: "早丢了的", customerId: c.id, amount: 1, status: "LOST", ownerId: jia.id } });
    await prisma.followPlan.create({ data: { customerId: c.id, subject: "做过了的", plannedAt: new Date(), ownerId: jia.id, done: true } });
    const r = await listContractLinks(c.id);
    expect(r.商机.map((x) => x.id)).toEqual([o.id]);
    expect(r.计划.map((x) => x.id)).toEqual([p.id]);
    expect(r.待办.map((x) => x.id)).toEqual([t.id]);
  });

  it("勾了赢单 → 商机 WON；勾了完成计划 / 待办 → done；各自留痕", async () => {
    const { c, o, p, t } = await 在谈的();
    const r = await saveContract({
      customerId: c.id, amount: 86000, signedAt: 今天(), remark: null,
      联动: { 赢单: [o.id], 完成计划: [p.id], 完成待办: [t.id] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.联动).toEqual({ 赢单: 1, 完成计划: 1, 完成待办: 1 });

    const opp = await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } });
    expect(opp.status).toBe("WON");
    expect(opp.stage).toBe("赢单成交");
    expect((await prisma.followPlan.findUniqueOrThrow({ where: { id: p.id } })).done).toBe(true);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).done).toBe(true);

    // 走的是原来那几个 action，所以日志里各有一条——不是签约那一条顺带说一句
    const 日志 = await prisma.auditLog.findMany({ select: { entity: true, summary: true } });
    expect(日志.map((x) => x.entity).sort()).toEqual(["Contract", "FollowPlan", "Opportunity", "Task"]);
    expect(日志.find((x) => x.entity === "Opportunity")?.summary).toContain("赢单");
  });

  it("一样都不勾：签约照登记，商机、计划、待办一个都不动", async () => {
    const { c, o, p, t } = await 在谈的();
    const r = await saveContract({ customerId: c.id, amount: 86000, signedAt: 今天(), remark: null, 联动: { 赢单: [], 完成计划: [], 完成待办: [] } });
    expect(r.ok).toBe(true);
    expect(await prisma.contract.count({ where: { customerId: c.id } })).toBe(1);
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("OPEN");
    expect((await prisma.followPlan.findUniqueOrThrow({ where: { id: p.id } })).done).toBe(false);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).done).toBe(false);
  });

  it("不传联动（建议卡 add_contract 那条路）和原来一样，只登记签约", async () => {
    const { c, o } = await 在谈的();
    const r = await saveContract({ customerId: c.id, amount: 86000, signedAt: 今天(), remark: null });
    expect(r.ok && r.联动).toBeFalsy();
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("OPEN");
  });

  it("只勾一部分就只动那一部分", async () => {
    const { c, o, p, t } = await 在谈的();
    await saveContract({ customerId: c.id, amount: 86000, signedAt: 今天(), remark: null, 联动: { 赢单: [o.id], 完成计划: [], 完成待办: [] } });
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("WON");
    expect((await prisma.followPlan.findUniqueOrThrow({ where: { id: p.id } })).done).toBe(false);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).done).toBe(false);
  });

  it("别人家的商机、已丢单的商机，塞进勾选里也不动", async () => {
    const { c } = await 在谈的("周明远");
    const 别人 = await 在谈的("许嘉怡");
    const 丢了 = await prisma.opportunity.create({ data: { name: "丢了的", customerId: c.id, amount: 1, status: "LOST", ownerId: jia.id } });
    const r = await saveContract({
      customerId: c.id, amount: 86000, signedAt: 今天(), remark: null,
      联动: { 赢单: [别人.o.id, 丢了.id], 完成计划: [别人.p.id], 完成待办: [别人.t.id] },
    });
    expect(r.ok && r.联动).toEqual({ 赢单: 0, 完成计划: 0, 完成待办: 0 });
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: 别人.o.id } })).status).toBe("OPEN");
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: 丢了.id } })).status).toBe("LOST");
    expect((await prisma.followPlan.findUniqueOrThrow({ where: { id: 别人.p.id } })).done).toBe(false);
  });

  it("被查重拦下来的那一次什么都不动；确认是另一笔再提交时才收尾", async () => {
    const { c, o } = await 在谈的();
    await saveContract({ customerId: c.id, amount: 86000, signedAt: 今天(), remark: null });
    const 勾 = { 赢单: [o.id], 完成计划: [], 完成待办: [] };
    const 拦 = await saveContract({ customerId: c.id, amount: 86000, signedAt: 今天(), remark: null, 联动: 勾 });
    expect(拦.ok).toBe(false);
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("OPEN");
    const 再 = await saveContract({ customerId: c.id, amount: 86000, signedAt: 今天(), remark: null, force: true, 联动: 勾 });
    expect(再.ok).toBe(true);
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("WON");
  });

  it("编辑一笔旧签约不牵动别的，哪怕带了勾选", async () => {
    const { c, o } = await 在谈的();
    const ct = await prisma.contract.create({ data: { customerId: c.id, amount: 1000, signedAt: 今天() } });
    await saveContract({ id: ct.id, customerId: c.id, amount: 2000, signedAt: 今天(), remark: null, 联动: { 赢单: [o.id], 完成计划: [], 完成待办: [] } });
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("OPEN");
  });
});

describe("标赢单后顺手登记签约", () => {
  it("setOppStatus(WON) 之后走 saveContract：客户到「已签约」、签约金额带过去", async () => {
    const { c, o } = await 在谈的();
    expect((await setOppStatus(o.id, "WON")).ok).toBe(true);
    const r = await saveContract({ customerId: c.id, amount: o.amount, signedAt: 今天(), remark: `商机「${o.name}」赢单时登记` });
    expect(r.ok).toBe(true);
    const 客户 = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(客户.followStatus).toBe("已签约");
    expect((await prisma.contract.findFirstOrThrow({ where: { customerId: c.id } })).amount).toBe(86000);
  });
});

describe("丢单的撤销：原样撤回去", () => {
  it("标丢单清零了概率；撤销带着原阶段和原概率改回进行中", async () => {
    const { o } = await 在谈的();
    await setOppStatus(o.id, "LOST");
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).probability).toBe(0);
    const r = await setOppStatus(o.id, "OPEN", { stage: "方案报价", probability: 60 });
    expect(r.ok).toBe(true);
    const back = await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } });
    expect(back).toMatchObject({ status: "OPEN", stage: "方案报价", probability: 60 });
  });

  it("还原的阶段 / 概率不合法就拒绝，不写库", async () => {
    const { o } = await 在谈的();
    await setOppStatus(o.id, "LOST");
    expect((await setOppStatus(o.id, "OPEN", { stage: "瞎写的", probability: 60 })).ok).toBe(false);
    expect((await setOppStatus(o.id, "OPEN", { stage: "方案报价", probability: 180 })).ok).toBe(false);
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("LOST");
  });
});
