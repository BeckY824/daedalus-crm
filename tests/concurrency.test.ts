/**
 * 多人同时操作的行为测试。
 *
 * 这一组直接调真实的 Server Action（用 vi.mock 顶掉登录与缓存失效两个只有
 * Next 运行时才有的依赖），而不是自己拼 Prisma 语句——并发闸门的正确性取决于
 * action 里判断和写入是不是同一条语句，绕过 action 就测不到这一点。
 *
 * 场景都来自「两个人各干各的、互相没说」：同时改同一条学员、同时转化同一条线索、
 * 各自设主要联系人、一个人删另一个人正在编辑的记录。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import {
  saveCustomer, deleteCustomers, assignSalesOwner, bulkFollowStatus,
  saveContract, deleteContract,
} from "@/app/(app)/customers/actions";
import { saveFollowUp, saveContact } from "@/app/(app)/customers/[id]/actions";
import { convertLead } from "@/app/(app)/leads/actions";
import { saveOpportunity, moveStage } from "@/app/(app)/opportunities/actions";
import { deactivateUser, saveUser, changeMyPassword } from "@/app/(app)/settings/actions";

let jia: { id: string };
let yi: { id: string };

/** 编辑框打开那一刻拿到的东西：版本号 + 一整份基准快照 */
type OpenForm = { id: string; updatedAt: string; base: Parameters<typeof saveCustomer>[0]["base"] };

/** 模拟打开某条学员的编辑框 */
async function openForm(id: string): Promise<OpenForm> {
  const r = await prisma.customer.findUniqueOrThrow({ where: { id } });
  return {
    id,
    updatedAt: r.updatedAt.toISOString(),
    base: {
      name: r.name, phone: r.phone, school: r.school, grade: r.grade, major: r.major,
      followStatus: r.followStatus, decisionStatus: r.decisionStatus,
      expectedSignAt: r.expectedSignAt, remark: r.remark, salesOwnerId: r.salesOwnerId,
      channelId: r.channelId, referrerCustomerId: r.referrerCustomerId,
    },
  };
}

/** 用真实 action 建一条学员，返回打开编辑框后的状态 */
async function newCustomer(name: string, phone: string): Promise<OpenForm> {
  const res = await saveCustomer({
    name, phone, school: null, grade: null, major: null,
    followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null,
    remark: null, salesOwnerId: jia.id, channelId: null, referrerCustomerId: null,
  });
  if (!res.ok) throw new Error("建档失败：" + res.error);
  return openForm(res.id);
}

/**
 * 模拟某人在自己那一版的基础上提交一次修改。
 * patch 是他在表单里动过的字段，其余原样提交——真实表单就是这么发的。
 */
function submit(f: OpenForm, patch: Record<string, unknown> = {}) {
  return saveCustomer({
    id: f.id,
    updatedAt: f.updatedAt,
    base: f.base,
    ...(f.base as Record<string, unknown>),
    ...patch,
  } as Parameters<typeof saveCustomer>[0]);
}

/** 不带 base 的旧式提交，用来验证兜底行为 */
function submitWithoutBase(f: OpenForm, patch: Record<string, unknown> = {}) {
  return saveCustomer({
    id: f.id,
    updatedAt: f.updatedAt,
    ...(f.base as Record<string, unknown>),
    ...patch,
  } as Parameters<typeof saveCustomer>[0]);
}

beforeEach(async () => {
  await resetDb();

  jia = await prisma.user.create({ data: { email: "jia", name: "甲", title: "销售", role: "ADMIN", password: "x" } });
  yi = await prisma.user.create({ data: { email: "yi", name: "乙", title: "销售", role: "SALES", password: "x" } });
  await prisma.channel.create({ data: { name: "小红", channelOwnerId: jia.id } });
  mocks.user = { id: jia.id, name: "甲", email: "jia", role: "ADMIN", title: "管理员", avatar: null };
});

afterAll(async () => { await prisma.$disconnect(); });

describe("两人同时编辑同一条学员", () => {
  it("改的是不同字段时自动合并，谁的改动都不丢", async () => {
    const c = await newCustomer("被同时改的", "13800000001");
    // 甲乙同时打开，看到的是同一版
    const 甲 = await openForm(c.id);
    const 乙 = await openForm(c.id);

    expect((await submit(甲, { school: "北京大学" })).ok).toBe(true);
    // 乙基于旧版本提交，但他改的是另一个字段，不该被拦
    expect((await submit(乙, { major: "计算机" })).ok).toBe(true);

    const after = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.school).toBe("北京大学"); // 甲的还在
    expect(after.major).toBe("计算机");    // 乙的也进去了
  });

  it("改到同一个字段才算冲突，后提交的被拒绝且不覆盖", async () => {
    const c = await newCustomer("撞同一项的", "13800000001");
    const 甲 = await openForm(c.id);
    const 乙 = await openForm(c.id);

    expect((await submit(甲, { school: "北京大学" })).ok).toBe(true);

    const r = await submit(乙, { school: "清华大学" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.conflict?.fields).toEqual(["院校"]);

    const after = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.school).toBe("北京大学"); // 甲的没被盖
  });

  it("冲突提示只列真正撞车的字段，不把我自己改的算进去", async () => {
    const c = await newCustomer("字段清单", "13800000001");
    const 甲 = await openForm(c.id);
    const 乙 = await openForm(c.id);

    // 甲改了院校和跟进状态
    await submit(甲, { school: "北京大学", followStatus: "意向较高" });
    // 乙也改院校（撞车），另外改了专业（甲没碰）
    const r = await submit(乙, { school: "清华大学", major: "金融学" });
    if (r.ok) throw new Error("应当冲突");

    // 撞的只有院校；专业是乙自己改的，不该出现在冲突清单里
    expect(r.conflict?.fields).toEqual(["院校"]);
    // 但要告诉乙对方还动了什么，好让他判断要不要放弃自己的改动
    expect(r.conflict?.theirFields).toContain("院校");
    expect(r.conflict?.theirFields).toContain("跟进状态");
    expect(r.conflict?.theirFields).not.toContain("专业");
  });

  it("对方只录了跟进、没碰学员资料，保存不该被打扰", async () => {
    /**
     * 这是日常最高频的路径：录跟进会同步 Customer.lastFollowAt，
     * 版本号跟着变，但编辑框里的字段一个没动。
     * 早先的实现会把这种情况判成冲突，还会把用户自己改的字段列成「不一致」。
     */
    const c = await newCustomer("正在被跟进的", "13800000001");
    const 甲 = await openForm(c.id);

    const fu = await saveFollowUp({
      customerId: c.id, type: "PHONE", title: "电话沟通", content: "聊了课程",
      status: "已完成", occurredAt: new Date().toISOString(),
    });
    expect(fu.ok).toBe(true);
    const bumped = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(bumped.updatedAt.toISOString()).not.toBe(甲.updatedAt); // 版本号确实变了
    expect(bumped.lastFollowAt).not.toBeNull();

    // 甲照常保存，不该看到任何冲突
    const r = await submit(甲, { major: "计算机" });
    expect(r.ok).toBe(true);
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.major).toBe("计算机");
    expect(after.lastFollowAt).not.toBeNull(); // 跟进时间也没被抹掉
  });

  it("我什么都没改就点保存，不报错也不写库", async () => {
    const c = await newCustomer("空保存", "13800000001");
    const 甲 = await openForm(c.id);
    await submit(await openForm(c.id), { school: "北京大学" }); // 别人改了
    const r = await submit(甲); // 甲原样提交
    expect(r.ok).toBe(true);
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.school).toBe("北京大学"); // 没被甲的旧值盖回去
  });

  it("合并时改推荐人，归属三件套要跟着重算", async () => {
    const 渠道 = await prisma.channel.findFirstOrThrow({ where: { name: "小红" } });
    // 上游由渠道「小红」直接推荐，因此它自己带着 channelId 和渠道负责人
    const 上游 = await newCustomer("上游", "13800000001");
    expect((await submit(await openForm(上游.id), { channelId: 渠道.id })).ok).toBe(true);

    const c = await newCustomer("下游", "13800000002");
    const 甲 = await openForm(c.id);
    // 乙先改了个不相干的字段，把版本号推走
    await submit(await openForm(c.id), { school: "北京大学" });
    // 甲基于旧版本改推荐人，走的是合并路径
    expect((await submit(甲, { referrerCustomerId: 上游.id })).ok).toBe(true);

    const after = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.school).toBe("北京大学");        // 乙的改动保住了
    expect(after.referrerCustomerId).toBe(上游.id);
    // 合并路径必须把归属三件套一起写进去，只写推荐人会留下一条算不出归属的记录
    expect(after.channelId).toBe(渠道.id);
    expect(after.attributionChannelId).toBe(渠道.id); // 上游不足两代，归属取链条顶端
    expect(after.channelOwnerId).toBe(jia.id);        // 渠道负责人整条线继承
  });

  it("拿到最新版本重新提交就能存下", async () => {
    const c = await newCustomer("重试的", "13800000001");
    await submit(await openForm(c.id), { school: "北京大学" });
    const r = await submit(await openForm(c.id), { school: "清华大学" });
    expect(r.ok).toBe(true);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).school).toBe("清华大学");
  });

  it("编辑期间记录被别人删掉，要明说删了而不是静默失败", async () => {
    const c = await newCustomer("被删的", "13800000001");
    const 甲 = await openForm(c.id);
    expect((await deleteCustomers([c.id])).ok).toBe(true);

    const r = await submit(甲, { school: "北京大学" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("已被其他人删除");
  });

  it("不带版本号的修改请求一律拒绝，避免绕开闸门", async () => {
    const c = await newCustomer("没版本号", "13800000001");
    const r = await submit({ ...(await openForm(c.id)), updatedAt: "" }, { school: "北京大学" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("版本");
  });

  it("不带 base 快照时退回保守行为：对不上就拦", async () => {
    const c = await newCustomer("无快照", "13800000001");
    const 甲 = await openForm(c.id);
    await submit(await openForm(c.id), { school: "北京大学" });
    // 老客户端不发 base，分不清谁改了什么，只能一律拦下
    const r = await submitWithoutBase(甲, { major: "计算机" });
    expect(r.ok).toBe(false);
  });

  it("同一毫秒内改同一字段，旧版本号同样要被挡住", async () => {
    /**
     * updatedAt 只精确到毫秒。两次保存落进同一毫秒时版本号不变，
     * 旧版本号会再次匹配成功、闸门被绕过——正是这条用例把它逼出来的。
     * 修法是保存时把版本号强制推进一格。跑 40 轮压住偶然性。
     */
    for (let i = 0; i < 40; i++) {
      const phone = "1380000" + String(1000 + i);
      const c = await newCustomer("同毫秒" + i, phone);
      const 甲 = await openForm(c.id);
      const 乙 = await openForm(c.id);
      expect((await submit(甲, { school: "北京大学" })).ok).toBe(true);
      expect((await submit(乙, { school: "清华大学" })).ok, `第 ${i} 轮：旧版本号没被挡住`).toBe(false);
    }
  });

  it("两人真正同时改同一字段，只有一个能存进去", async () => {
    for (let i = 0; i < 20; i++) {
      const phone = "1380000" + String(2000 + i);
      const c = await newCustomer("同时提交" + i, phone);
      const 甲 = await openForm(c.id);
      const 乙 = await openForm(c.id);
      const [a, b] = await Promise.all([
        submit(甲, { school: "北京大学" }),
        submit(乙, { school: "清华大学" }),
      ]);
      expect([a.ok, b.ok].filter(Boolean), `第 ${i} 轮：两边都存进去了`).toHaveLength(1);
    }
  });

  it("新建不需要版本号，不受闸门影响", async () => {
    const c = await newCustomer("新建的", "13800000009");
    expect(c.id).toBeTruthy();
  });
});

describe("推荐链成环", () => {
  it("A 推荐了 B，就不能反过来把 B 设成 A 的推荐人", async () => {
    const a = await newCustomer("小明", "13800000001");
    const b = await newCustomer("室友", "13800000002");
    // 室友的推荐人是小明
    expect((await submit(await openForm(b.id), { referrerCustomerId: a.id })).ok).toBe(true);

    const r = await submit(await openForm(a.id), { referrerCustomerId: b.id });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("成环");
  });

  it("隔了几代也要挡住：A→B→C 时不能把 C 设成 A 的推荐人", async () => {
    const a = await newCustomer("小明", "13800000001");
    const b = await newCustomer("室友", "13800000002");
    const c = await newCustomer("朋友", "13800000003");
    await submit(await openForm(b.id), { referrerCustomerId: a.id });
    await submit(await openForm(c.id), { referrerCustomerId: b.id });

    const r = await submit(await openForm(a.id), { referrerCustomerId: c.id });
    expect(r.ok).toBe(false);
  });

  it("推荐人不能是自己", async () => {
    const a = await newCustomer("小明", "13800000001");
    const r = await submit(await openForm(a.id), { referrerCustomerId: a.id });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("本人");
  });

  it("正常的推荐关系不受影响", async () => {
    const a = await newCustomer("小明", "13800000001");
    const b = await newCustomer("室友", "13800000002");
    expect((await submit(await openForm(b.id), { referrerCustomerId: a.id })).ok).toBe(true);
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.referrerCustomerId).toBe(a.id);
  });
});

describe("两人同时转化同一条线索", () => {
  async function mkLead() {
    return prisma.lead.create({
      data: { name: "王同学", phone: "13900000001", contact: "王同学", source: "官网注册", status: "待跟进", ownerId: jia.id },
    });
  }

  it("同时点转化，只会建出一条学员", async () => {
    const lead = await mkLead();
    const [a, b] = await Promise.all([convertLead(lead.id), convertLead(lead.id)]);

    const ok = [a, b].filter((r) => r.ok);
    expect(ok).toHaveLength(1);
    expect(await prisma.customer.count({ where: { phone: "13900000001" } })).toBe(1);

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).toBe("已转化");
    expect(after.customerId).toBeTruthy();
  });

  it("失败的一方要收到明确原因，而不是默默什么都没发生", async () => {
    const lead = await mkLead();
    const [a, b] = await Promise.all([convertLead(lead.id), convertLead(lead.id)]);
    const failed = [a, b].find((r) => !r.ok);
    expect(failed && "error" in failed && failed.error).toBeTruthy();
  });

  it("已转化的线索再点一次会被挡住", async () => {
    const lead = await mkLead();
    expect((await convertLead(lead.id)).ok).toBe(true);
    const again = await convertLead(lead.id);
    expect(again.ok).toBe(false);
  });
});

describe("编辑别人的记录不该顺手改掉归属", () => {
  it("乙修改甲写的跟进记录，这条记录仍算甲的", async () => {
    const c = await newCustomer("学员", "13800000001");
    const created = await saveFollowUp({
      customerId: c.id, type: "PHONE", title: "首次电话", content: "介绍课程",
      status: "已完成", occurredAt: new Date().toISOString(),
    });
    expect(created.ok).toBe(true);
    const fu = await prisma.followUp.findFirstOrThrow({ where: { customerId: c.id } });
    expect(fu.ownerId).toBe(jia.id);

    // 换成乙登录，只是改个错字
    mocks.user = { id: yi.id, name: "乙", email: "yi", role: "SALES", title: "销售", avatar: null };
    const edited = await saveFollowUp({
      id: fu.id, customerId: c.id, type: "PHONE", title: "首次电话沟通", content: "介绍课程",
      status: "已完成", occurredAt: fu.occurredAt.toISOString(),
    });
    expect(edited.ok).toBe(true);

    const after = await prisma.followUp.findUniqueOrThrow({ where: { id: fu.id } });
    expect(after.title).toBe("首次电话沟通");
    expect(after.ownerId).toBe(jia.id); // 归属没被乙拿走
  });
});

describe("主要联系人只能有一个", () => {
  it("两人各自把不同联系人设为主要，最终只留一个", async () => {
    const c = await newCustomer("学员", "13800000001");
    await saveContact({ customerId: c.id, name: "妈妈", isPrimary: true });
    await saveContact({ customerId: c.id, name: "本人", isPrimary: true });

    const primaries = await prisma.contact.findMany({ where: { customerId: c.id, isPrimary: true } });
    expect(primaries).toHaveLength(1);
    expect(primaries[0].name).toBe("本人");
    expect(await prisma.contact.count({ where: { customerId: c.id } })).toBe(2);
  });
});

describe("成员停用与转交的完整性", () => {
  it("线索与渠道负责人也要一并转交，不能留在停用的人名下", async () => {
    await prisma.lead.create({
      data: { name: "线索", phone: "13900000009", source: "官网注册", status: "待跟进", ownerId: yi.id },
    });
    await prisma.channel.create({ data: { name: "老李", channelOwnerId: yi.id } });
    await prisma.customer.create({
      data: { name: "学员", phone: "13800000099", salesOwnerId: yi.id, channelOwnerId: yi.id },
    });

    const res = await deactivateUser(yi.id, jia.id);
    expect(res.ok).toBe(true);

    expect(await prisma.lead.count({ where: { ownerId: yi.id } })).toBe(0);
    expect(await prisma.channel.count({ where: { channelOwnerId: yi.id } })).toBe(0);
    expect(await prisma.customer.count({ where: { channelOwnerId: yi.id } })).toBe(0);
    expect(await prisma.customer.count({ where: { salesOwnerId: yi.id } })).toBe(0);
  });

  it("不能把数据转交给一个已经停用的人", async () => {
    await prisma.user.update({ where: { id: yi.id }, data: { active: false } });
    const res = await deactivateUser(jia.id, yi.id);
    expect(res.ok).toBe(false);
  });

  it("最后一个管理员不能被停用", async () => {
    const res = await deactivateUser(jia.id, yi.id);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toContain("最后一个管理员");
  });

  it("最后一个管理员也不能被降级成销售", async () => {
    const res = await saveUser({
      id: jia.id, name: "甲", email: "jia", title: "销售", role: "SALES", active: true,
    });
    expect(res.ok).toBe(false);
  });

  it("还有别的管理员时，降级是允许的", async () => {
    await prisma.user.update({ where: { id: yi.id }, data: { role: "ADMIN" } });
    const res = await saveUser({
      id: jia.id, name: "甲", email: "jia", title: "销售", role: "SALES", active: true,
    });
    expect(res.ok).toBe(true);
  });

  it("停用要走「停用并转交」，不能在编辑框里直接勾掉", async () => {
    const res = await saveUser({
      id: yi.id, name: "乙", email: "yi", title: "销售", role: "SALES", active: false,
    });
    expect(res.ok).toBe(false);
    // saveUser 的失败分支现在有两种：普通报错，和同名待确认
    if (res.ok || !("error" in res)) throw new Error("unreachable");
    expect(res.error).toContain("停用");
  });
});

describe("接口直调能写进来的脏数据", () => {
  it("商机金额不能为负、概率不能越界", async () => {
    const c = await newCustomer("学员", "13800000001");
    const base = { name: "商机", customerId: c.id, stage: "初步沟通", status: "OPEN", ownerId: jia.id };
    expect((await saveOpportunity({ ...base, amount: -1, probability: 20 })).ok).toBe(false);
    expect((await saveOpportunity({ ...base, amount: 100, probability: 500 })).ok).toBe(false);
    expect((await saveOpportunity({ ...base, amount: 100, probability: -1 })).ok).toBe(false);
    expect((await saveOpportunity({ ...base, amount: 100, probability: 20 })).ok).toBe(true);
  });

  it("商机阶段与状态有白名单", async () => {
    const c = await newCustomer("学员", "13800000001");
    const base = { name: "商机", customerId: c.id, amount: 100, probability: 20, ownerId: jia.id };
    expect((await saveOpportunity({ ...base, stage: "随便写的", status: "OPEN" })).ok).toBe(false);
    expect((await saveOpportunity({ ...base, stage: "初步沟通", status: "随便写的" })).ok).toBe(false);
  });

  it("已丢单的商机换个阶段不会被静默改回进行中", async () => {
    const c = await newCustomer("学员", "13800000001");
    const o = await prisma.opportunity.create({
      data: { customerId: c.id, name: "丢了的", amount: 100, ownerId: jia.id, stage: "方案报价", status: "LOST" },
    });
    expect((await moveStage(o.id, "需求确认")).ok).toBe(true);
    const after = await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.stage).toBe("需求确认");
    expect(after.status).toBe("LOST");
  });

  it("跟进标题选填：不填能存，填了原样保留", async () => {
    /**
     * 标题原本必填却从不在时间线上展示，等于逼销售每条编一句没人看的话，
     * 直接催生「标题栏全填句号」这种数据。2026-08-29 改为选填 + 有则展示。
     * 数据库列仍是 NOT NULL，空的时候存空串——不为这个改表结构。
     */
    const c = await newCustomer("标题选填", "13800000001");
    const base = { customerId: c.id, type: "PHONE", content: "内容", status: "已完成", occurredAt: new Date().toISOString() };

    expect((await saveFollowUp({ ...base })).ok).toBe(true);
    expect((await saveFollowUp({ ...base, title: "" })).ok).toBe(true);
    expect((await saveFollowUp({ ...base, title: "  " })).ok).toBe(true);
    expect((await saveFollowUp({ ...base, title: "首次电话" })).ok).toBe(true);

    const 全部 = await prisma.followUp.findMany({ where: { customerId: c.id }, orderBy: { title: "asc" } });
    expect(全部).toHaveLength(4);
    expect(全部.filter((f) => f.title === "")).toHaveLength(3); // 空白一律归一成空串
    expect(全部.find((f) => f.title === "首次电话")).toBeTruthy();
  });

  it("跟进记录的类型与状态有白名单，时长不能为负", async () => {
    const c = await newCustomer("学员", "13800000001");
    const base = { customerId: c.id, title: "标题", content: "内容", occurredAt: new Date().toISOString() };
    expect((await saveFollowUp({ ...base, type: "随便写的", status: "已完成" })).ok).toBe(false);
    expect((await saveFollowUp({ ...base, type: "PHONE", status: "随便写的" })).ok).toBe(false);
    expect((await saveFollowUp({ ...base, type: "PHONE", status: "已完成", durationMinutes: -5 })).ok).toBe(false);
    expect((await saveFollowUp({ ...base, type: "PHONE", status: "已完成", durationMinutes: 5 })).ok).toBe(true);
  });

  it("密码不能设成空或过短", async () => {
    await prisma.user.update({
      where: { id: jia.id },
      data: { password: (await import("bcryptjs")).default.hashSync("crm@2026", 10) },
    });
    expect((await changeMyPassword("crm@2026", "")).ok).toBe(false);
    expect((await changeMyPassword("crm@2026", "123")).ok).toBe(false);
    expect((await changeMyPassword("crm@2026", "crm@2026")).ok).toBe(false);
    expect((await changeMyPassword("crm@2026", "NewPwd@2026")).ok).toBe(true);
  });
});

describe("签约查重：同学员 + 同金额 + 同一天", () => {
  const 今天 = () => new Date(2026, 7, 29, 10, 0, 0);

  it("第二次录同样的一笔会被拦下来确认，且不写库", async () => {
    const c = await newCustomer("签约的", "13800000001");
    expect((await saveContract({ customerId: c.id, amount: 19800, signedAt: 今天(), remark: null })).ok).toBe(true);

    const again = await saveContract({ customerId: c.id, amount: 19800, signedAt: 今天(), remark: null });
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("unreachable");
    expect("duplicate" in again && again.duplicate.amount).toBe(19800);
    // 关键：拦下来的这一笔不能落库，否则业绩就翻倍了
    expect(await prisma.contract.count({ where: { customerId: c.id } })).toBe(1);
  });

  it("确认「确实是另一笔」后照录，续费分期不受影响", async () => {
    const c = await newCustomer("续费的", "13800000001");
    await saveContract({ customerId: c.id, amount: 19800, signedAt: 今天(), remark: null });
    const forced = await saveContract({ customerId: c.id, amount: 19800, signedAt: 今天(), remark: null, force: true });
    expect(forced.ok).toBe(true);

    const sum = await prisma.contract.aggregate({ where: { customerId: c.id }, _sum: { amount: true } });
    expect(sum._sum.amount).toBe(39600);
  });

  it("金额不同或日期不同都直接放行，不打扰人", async () => {
    const c = await newCustomer("多笔的", "13800000001");
    await saveContract({ customerId: c.id, amount: 19800, signedAt: 今天(), remark: null });
    expect((await saveContract({ customerId: c.id, amount: 5000, signedAt: 今天(), remark: null })).ok).toBe(true);
    expect((await saveContract({
      customerId: c.id, amount: 19800, signedAt: new Date(2026, 7, 30, 10, 0, 0), remark: null,
    })).ok).toBe(true);
    expect(await prisma.contract.count({ where: { customerId: c.id } })).toBe(3);
  });

  it("「同一天」按自然日算，同日不同时刻仍算重复", async () => {
    const c = await newCustomer("同日的", "13800000001");
    await saveContract({ customerId: c.id, amount: 19800, signedAt: new Date(2026, 7, 29, 9, 0, 0), remark: null });
    const 晚上 = await saveContract({ customerId: c.id, amount: 19800, signedAt: new Date(2026, 7, 29, 23, 30, 0), remark: null });
    expect(晚上.ok).toBe(false);
  });

  it("编辑已有的那条时不该把它自己算成重复", async () => {
    const c = await newCustomer("改签约的", "13800000001");
    await saveContract({ customerId: c.id, amount: 19800, signedAt: 今天(), remark: null });
    const ct = await prisma.contract.findFirstOrThrow({ where: { customerId: c.id } });
    const edited = await saveContract({
      id: ct.id, customerId: c.id, amount: 19800, signedAt: 今天(), remark: "补了个备注",
    });
    expect(edited.ok).toBe(true);
  });

  it("金额仍然不能为零或负数", async () => {
    const c = await newCustomer("脏金额", "13800000001");
    expect((await saveContract({ customerId: c.id, amount: 0, signedAt: 今天(), remark: null })).ok).toBe(false);
    expect((await saveContract({ customerId: c.id, amount: -5000, signedAt: 今天(), remark: null })).ok).toBe(false);
  });
});

describe("删除签约后的状态回退", () => {
  async function 带签约的学员() {
    const c = await newCustomer("已签约的", "13800000001");
    await saveContract({ customerId: c.id, amount: 19800, signedAt: new Date(), remark: null });
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.followStatus).toBe("已签约");
    const ct = await prisma.contract.findFirstOrThrow({ where: { customerId: c.id } });
    return { c, ct };
  }

  it("删掉最后一笔并指定回退档位，状态跟着退回", async () => {
    const { c, ct } = await 带签约的学员();
    const res = await deleteContract(ct.id, c.id, { followStatus: "意向较高", decisionStatus: "与家人商议" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.remaining).toBe(0);

    const after = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.followStatus).toBe("意向较高");
    expect(after.decisionStatus).toBe("与家人商议");
  });

  it("选择「保持不变」时状态原样停在已签约", async () => {
    const { c, ct } = await 带签约的学员();
    expect((await deleteContract(ct.id, c.id, null)).ok).toBe(true);
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.followStatus).toBe("已签约"); // 金额归零但状态不动，是人自己选的
  });

  it("还有别的签约时，即便传了回退档位也不该动状态", async () => {
    const { c, ct } = await 带签约的学员();
    await saveContract({ customerId: c.id, amount: 5000, signedAt: new Date(), remark: null });
    const res = await deleteContract(ct.id, c.id, { followStatus: "意向较高", decisionStatus: "与家人商议" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.remaining).toBe(1);
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.followStatus).toBe("已签约");
  });

  it("别人已经删过了，第二次要报错而不是假装成功", async () => {
    const { c, ct } = await 带签约的学员();
    expect((await deleteContract(ct.id, c.id, null)).ok).toBe(true);
    const again = await deleteContract(ct.id, c.id, null);
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("unreachable");
    expect(again.error).toContain("已不存在");
  });

  it("回退档位有白名单，接口直调塞不进枚举外的值", async () => {
    const { c, ct } = await 带签约的学员();
    const res = await deleteContract(ct.id, c.id, { followStatus: "随便写的", decisionStatus: "了解中" });
    expect(res.ok).toBe(false);
    expect(await prisma.contract.count({ where: { customerId: c.id } })).toBe(1); // 校验不过就不该删
  });
});

describe("批量操作要如实回报条数", () => {
  it("分别报出真改了几条、本来就是几条、已不存在几条", async () => {
    const a = await newCustomer("甲的", "13800000001");
    const b = await newCustomer("乙的", "13800000002");
    const 已删 = await newCustomer("要删的", "13800000003");
    // b 本来就归乙
    await prisma.customer.update({ where: { id: b.id }, data: { salesOwnerId: yi.id } });
    await prisma.customer.delete({ where: { id: 已删.id } });

    const res = await assignSalesOwner([a.id, b.id, 已删.id], yi.id);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.updated).toBe(1);   // 只有 a 真的改了
    expect(res.unchanged).toBe(1); // b 本来就是乙的
    expect(res.missing).toBe(1);   // 被删的那条
  });

  it("不能把学员批量转给已停用的成员", async () => {
    const a = await newCustomer("甲的", "13800000001");
    await prisma.user.update({ where: { id: yi.id }, data: { active: false } });
    const res = await assignSalesOwner([a.id], yi.id);
    expect(res.ok).toBe(false);
    // 拦下来之后不能有任何一条被改
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: a.id } })).salesOwnerId).toBe(jia.id);
  });

  it("批量改状态同样报真实条数，且有枚举白名单", async () => {
    const a = await newCustomer("甲的", "13800000001");
    const b = await newCustomer("乙的", "13800000002");
    await prisma.customer.update({ where: { id: b.id }, data: { followStatus: "意向较高" } });

    const res = await bulkFollowStatus([a.id, b.id], "意向较高");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.updated).toBe(1);
    expect(res.unchanged).toBe(1);

    expect((await bulkFollowStatus([a.id], "随便写的状态")).ok).toBe(false);
  });

  it("一条都没选时不报错也不写库", async () => {
    const res = await assignSalesOwner([], yi.id);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.updated).toBe(0);
  });
});
