/**
 * 企业版线索分配（lib/enterprise/lead-assign.ts + leads/assign-actions.ts）。
 * 钉的是：规则关着一律拒；老板 / 总管理员 / 市场管理能分，别人不能；只能分给销售、业务线要对得上；
 * 配额按月数、满了分不进去、不算数的不占配额；直属 / 虚线上级能设配额，别人不能；
 * 分出去以后原负责人仍能看到转化情况；营销企划算不算数走 Setting 留的口子。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "老板", email: "a@x", role: "ADMIN", title: "", avatar: null },
  企业版: true,
  共享区: false,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));
vi.mock("@/lib/enterprise/switch", () => ({ 企业版: () => mocks.企业版 }));
vi.mock("@/lib/shared-ws/current", () => ({ 当前是共享区: async () => mocks.共享区 }));

import { prisma } from "@/lib/prisma";
import { setSetting } from "@/lib/settings";
import { resetDb } from "./reset";
import { 分配线索, 设配额, 我分出去的线索, 本月分配情况, 自动分配线索 } from "@/app/(app)/leads/assign-actions";
import { 企划线索计数key, 月份, 计不计数, 满了, 挑接手人, 自动分配不参与key } from "@/lib/enterprise/lead-assign";
import { 规则 } from "@/lib/enterprise/rules";

let 老板: string, 总管: string, 市场: string, 销售经理: string, 内贸: string, 外贸: string, 两边: string, 虚线经理: string, 渠道: string;

const 当 = (id: string, role = "SALES") => { mocks.user = { ...mocks.user, id, role }; };
const 开 = (on = true) => setSetting(规则.线索分配.key, on);
const 建线索 = async (name: string, ownerId: string | null = 市场) => (await prisma.lead.create({ data: { name, ownerId } })).id;
const 负责人 = async (id: string) => (await prisma.lead.findUniqueOrThrow({ where: { id } })).ownerId;

beforeEach(async () => {
  await resetDb();
  mocks.企业版 = true;
  mocks.共享区 = false;
  const 人 = async (email: string, name: string, role = "SALES") => (await prisma.user.create({ data: { email, name, title: "", role, password: "x" } })).id;
  老板 = await 人("boss", "老板", "ADMIN");
  总管 = await 人("dir", "总管");
  市场 = await 人("mkt", "市场小李");
  销售经理 = await 人("smgr", "销售经理");
  虚线经理 = await 人("dmgr", "虚线经理");
  内贸 = await 人("in", "内贸小王");
  外贸 = await 人("out", "外贸小张");
  两边 = await 人("both", "两边小赵");
  渠道 = await 人("cs", "渠道");
  await prisma.entMember.createMany({
    data: [
      { userId: 总管, bizRole: "director" },
      { userId: 市场, bizRole: "marketing_mgr" },
      { userId: 销售经理, bizRole: "sales_mgr" },
      { userId: 虚线经理, bizRole: "sales_mgr" },
      { userId: 内贸, bizRole: "sales", line: "内贸", managerId: 销售经理 },
      { userId: 外贸, bizRole: "sales", line: "外贸", managerId: 销售经理, dottedManagerId: 虚线经理 },
      { userId: 两边, bizRole: "sales" },
      { userId: 渠道, bizRole: "channel_ops" },
    ],
  });
  当(老板, "ADMIN");
});

describe("纯函数", () => {
  it("月份按本地时间、补零", () => {
    expect(月份(new Date(2026, 0, 31, 23, 59))).toBe("2026-01");
    expect(月份(new Date(2026, 1, 1, 0, 0))).toBe("2026-02");
  });
  it("营销企划算不算数：没设 = 算，设了听设置；营销线索总算", () => {
    expect(计不计数("营销企划", null)).toBe(true);
    expect(计不计数("营销企划", false)).toBe(false);
    expect(计不计数("营销", false)).toBe(true);
  });
  it("配额 null = 不限", () => {
    expect(满了(999, null)).toBe(false);
    expect(满了(3, 3)).toBe(true);
    expect(满了(2, 3)).toBe(false);
  });
});

describe("挑接手人（自动分配）", () => {
  const 时 = (n: number) => new Date(2026, 0, n);
  const 候 = [
    { userId: "b", 已分: 1, 配额: null, 进池: 时(1) },
    { userId: "c", 已分: 0, 配额: null, 进池: 时(3) },
    { userId: "a", 已分: 0, 配额: null, 进池: 时(2) },
    { userId: "z", 已分: 0, 配额: 0, 进池: 时(1) },
  ];
  it("已分最少的；一样多给最早进池的", () => {
    expect(挑接手人(候, new Set(), true)).toBe("a");
  });
  it("不参与的、分满的跳过；这一条不算数时不看满没满", () => {
    expect(挑接手人(候, new Set(["a"]), true)).toBe("c");
    expect(挑接手人(候, new Set(), false)).toBe("z");
  });
  it("进池时间也一样按 id；没人可挑 = null", () => {
    expect(挑接手人([{ userId: "y", 已分: 0, 配额: null, 进池: 时(1) }, { userId: "x", 已分: 0, 配额: null, 进池: 时(1) }], new Set(), true)).toBe("x");
    expect(挑接手人(候, new Set(["a", "b", "c", "z"]), true)).toBeNull();
  });
});

describe("自动分配线索", () => {
  beforeEach(async () => {
    await 开();
    // 进池先后：销售经理、虚线经理、内贸、外贸、两边
    for (const [i, id] of [销售经理, 虚线经理, 内贸, 外贸, 两边].entries()) await prisma.user.update({ where: { id }, data: { createdAt: new Date(2026, 0, i + 1) } });
    await setSetting(自动分配不参与key, [销售经理, 虚线经理]);
    当(市场);
  });

  it("挑本月已分最少的、业务线对得上的；走正常分配留记录", async () => {
    await 分配线索({ leadId: await 建线索("先给内贸"), toUserId: 内贸 });
    const L = await 建线索("L");
    const r = await 自动分配线索(L);
    // 内贸已分 1；外贸、两边都是 0，外贸进池早
    expect(r).toEqual({ ok: true, toUserId: 外贸 });
    expect(await 负责人(L)).toBe(外贸);
    expect(await prisma.entLeadAssign.count({ where: { leadId: L, toUserId: 外贸, byUserId: 市场, counted: true } })).toBe(1);
    // 走内贸线：外贸对不上，两边 0 条
    expect(await 自动分配线索(await 建线索("M"), { line: "内贸" })).toEqual({ ok: true, toUserId: 两边 });
  });

  it("分满的跳过；都满了报没人能接，线索不动", async () => {
    await prisma.entLeadQuota.createMany({ data: [{ userId: 内贸, quota: 0, setById: 老板 }, { userId: 外贸, quota: 0, setById: 老板 }] });
    expect(await 自动分配线索(await 建线索("L"))).toMatchObject({ ok: true, toUserId: 两边 });
    await prisma.entLeadQuota.create({ data: { userId: 两边, quota: 1, setById: 老板 } });
    const N = await 建线索("N");
    expect(await 自动分配线索(N)).toMatchObject({ ok: false, error: expect.stringMatching(/没有能接的人/) });
    expect(await 负责人(N)).toBe(市场);
    // 营销企划设成不算数：不看配额
    await setSetting(企划线索计数key, false);
    expect(await 自动分配线索(N, { kind: "营销企划" })).toMatchObject({ ok: true, toUserId: 内贸 });
  });

  it("两条同时自动分配、都挑中同一个只剩一个名额的人：后到的顺延给下一个，不超配额", async () => {
    await prisma.entLeadQuota.create({ data: { userId: 内贸, quota: 1, setById: 老板 } });
    const [A, B] = [await 建线索("A"), await 建线索("B")];
    const rs = await Promise.all([自动分配线索(A), 自动分配线索(B)]);
    // 内贸进池最早、两边都先挑中他；名额只有 1，另一条顺延给外贸
    expect(rs.map((r) => (r.ok ? r.toUserId : r.error)).sort()).toEqual([内贸, 外贸].sort());
    expect(await prisma.entLeadAssign.count({ where: { toUserId: 内贸 } })).toBe(1);
  });

  it("两个人同时手动分给同一个只剩一个名额的人：只进一条，另一条报分满、线索不动", async () => {
    await prisma.entLeadQuota.create({ data: { userId: 两边, quota: 1, setById: 老板 } });
    const [A, B] = [await 建线索("A"), await 建线索("B")];
    const rs = await Promise.all([分配线索({ leadId: A, toUserId: 两边 }), 分配线索({ leadId: B, toUserId: 两边 })]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)).toMatchObject({ error: expect.stringContaining("分满了") });
    expect(rs.find((r) => !r.ok)).not.toHaveProperty("满");
    expect(await prisma.entLeadAssign.count({ where: { toUserId: 两边 } })).toBe(1);
    expect([await 负责人(A), await 负责人(B)].sort()).toEqual([两边, 市场].sort());
  });

  it("现在的负责人不再分给自己；没设不参与名单 = 人人参与", async () => {
    await setSetting(自动分配不参与key, null);
    const L = await 建线索("L", 销售经理);
    expect(await 自动分配线索(L)).toMatchObject({ ok: true, toUserId: 虚线经理 });
  });

  it("不能分配的人、规则关着都拒", async () => {
    当(内贸);
    expect(await 自动分配线索(await 建线索("L"))).toMatchObject({ ok: false, error: expect.stringMatching(/只有老板/) });
    当(市场);
    await 开(false);
    expect((await 自动分配线索(await 建线索("M"))).ok).toBe(false);
  });
});

describe("规则关着", () => {
  it("一律拒，一行不写", async () => {
    const id = await 建线索("A");
    expect(await 分配线索({ leadId: id, toUserId: 内贸 })).toMatchObject({ ok: false, error: expect.stringContaining("没开") });
    expect(await 设配额(内贸, 5)).toMatchObject({ ok: false });
    expect(await 我分出去的线索()).toBeNull();
    expect(await 本月分配情况()).toBeNull();
    expect(await 负责人(id)).toBe(市场);
    expect(await prisma.entLeadAssign.count()).toBe(0);
  });
  it("不是企业版时开关打开也不生效", async () => {
    await 开();
    mocks.企业版 = false;
    expect(await 分配线索({ leadId: await 建线索("A"), toUserId: 内贸 })).toMatchObject({ ok: false });
  });
});

describe("分配", () => {
  beforeEach(() => 开());

  it("市场管理能把线索分给内贸、外贸销售，记一行、留操作记录", async () => {
    当(市场);
    const a = await 建线索("A");
    const b = await 建线索("B");
    expect(await 分配线索({ leadId: a, toUserId: 内贸, line: "内贸" })).toEqual({ ok: true });
    expect(await 分配线索({ leadId: b, toUserId: 外贸, line: "外贸" })).toEqual({ ok: true });
    expect(await 负责人(a)).toBe(内贸);
    expect(await 负责人(b)).toBe(外贸);
    const r = await prisma.entLeadAssign.findFirstOrThrow({ where: { leadId: a } });
    expect(r).toMatchObject({ toUserId: 内贸, fromUserId: 市场, byUserId: 市场, line: "内贸", kind: "营销", counted: true, month: 月份() });
    const 记录 = await prisma.auditLog.findMany({ where: { entity: "Lead" }, select: { summary: true } });
    expect(记录.map((x) => x.summary)).toContain("分配线索「A」给 内贸小王（内贸）");
  });

  it("老板、总管理员能分；销售、销售经理、渠道不能", async () => {
    for (const [id, role] of [[老板, "ADMIN"], [总管, "SALES"]] as const) {
      当(id, role);
      expect(await 分配线索({ leadId: await 建线索(`L${id}`), toUserId: 两边 })).toEqual({ ok: true });
    }
    for (const id of [内贸, 销售经理, 渠道]) {
      当(id);
      expect(await 分配线索({ leadId: await 建线索(`X${id}`), toUserId: 两边 })).toMatchObject({ ok: false, error: expect.stringContaining("只有老板、总管理员、市场管理") });
    }
  });

  it("只能分给销售 / 销售管理；业务线对不上拒；没填业务线的两边都能接", async () => {
    当(市场);
    const id = await 建线索("A");
    expect(await 分配线索({ leadId: id, toUserId: 渠道 })).toMatchObject({ ok: false, error: "线索只能分给销售或销售管理" });
    expect(await 分配线索({ leadId: id, toUserId: 内贸, line: "外贸" })).toMatchObject({ ok: false, error: "他是内贸销售，这条线索走外贸" });
    expect(await 分配线索({ leadId: id, toUserId: "nobody" })).toMatchObject({ ok: false, error: expect.stringContaining("不在组织里") });
    expect(await 分配线索({ leadId: id, toUserId: 两边, line: "外贸" })).toEqual({ ok: true });
    expect(await 分配线索({ leadId: await 建线索("B"), toUserId: 销售经理 })).toEqual({ ok: true });
  });

  it("接口直调塞乱值拒；已转化的、已经在他名下的、不存在的线索拒", async () => {
    当(市场);
    const id = await 建线索("A");
    expect(await 分配线索({ leadId: id, toUserId: 两边, line: "国际" as never })).toMatchObject({ ok: false, error: expect.stringContaining("业务线") });
    expect(await 分配线索({ leadId: id, toUserId: 两边, kind: "随便" as never })).toMatchObject({ ok: false, error: expect.stringContaining("线索种类") });
    expect(await 分配线索({ leadId: "nope", toUserId: 两边 })).toMatchObject({ ok: false, error: expect.stringContaining("不在了") });
    const 转了 = (await prisma.lead.create({ data: { name: "C", ownerId: 市场, status: "已转化" } })).id;
    expect(await 分配线索({ leadId: 转了, toUserId: 两边 })).toMatchObject({ ok: false, error: expect.stringContaining("已转化") });
    const 他的 = await 建线索("D", 两边);
    expect(await 分配线索({ leadId: 他的, toUserId: 两边 })).toMatchObject({ ok: false, error: expect.stringContaining("已经在他名下") });
    expect(await prisma.entLeadAssign.count()).toBe(0);
  });

  it("共享试用区不让分", async () => {
    mocks.共享区 = true;
    expect(await 分配线索({ leadId: await 建线索("A"), toUserId: 两边 })).toMatchObject({ ok: false });
  });
});

describe("配额", () => {
  beforeEach(() => 开());

  it("直属上级、虚线上级能设；别的经理、销售本人不能", async () => {
    当(销售经理);
    expect(await 设配额(外贸, 3)).toEqual({ ok: true });
    当(虚线经理);
    expect(await 设配额(外贸, 4)).toEqual({ ok: true });
    expect((await prisma.entLeadQuota.findUniqueOrThrow({ where: { userId: 外贸 } })).quota).toBe(4);
    expect(await 设配额(内贸, 4)).toMatchObject({ ok: false, error: expect.stringContaining("直属上级") });
    当(外贸);
    expect(await 设配额(外贸, 99)).toMatchObject({ ok: false });
    当(总管);
    expect(await 设配额(内贸, 1)).toEqual({ ok: true });
  });

  it("配额只收 0–10000 的整数；null = 取消，不限", async () => {
    expect(await 设配额(内贸, -1)).toMatchObject({ ok: false });
    expect(await 设配额(内贸, 1.5)).toMatchObject({ ok: false });
    expect(await 设配额(内贸, 2)).toEqual({ ok: true });
    expect(await 设配额(内贸, null)).toEqual({ ok: true });
    expect(await prisma.entLeadQuota.count()).toBe(0);
  });

  it("分满了分不进去；上月的不算；销售自己拓的不算", async () => {
    await 设配额(内贸, 2);
    await 建线索("自拓", 内贸); // 自己拓的：没有分配记录
    await prisma.entLeadAssign.create({ data: { leadId: "old", toUserId: 内贸, byUserId: 老板, month: "2000-01" } });
    当(市场);
    expect(await 分配线索({ leadId: await 建线索("A"), toUserId: 内贸 })).toEqual({ ok: true });
    expect(await 分配线索({ leadId: await 建线索("B"), toUserId: 内贸 })).toEqual({ ok: true });
    const c = await 建线索("C");
    expect(await 分配线索({ leadId: c, toUserId: 内贸 })).toMatchObject({ ok: false, error: expect.stringContaining("分满了") });
    expect(await 负责人(c)).toBe(市场);
  });

  it("营销企划线索：设成不算数就不占配额（留的口子）", async () => {
    await 设配额(内贸, 0);
    当(市场);
    expect(await 分配线索({ leadId: await 建线索("A"), toUserId: 内贸, kind: "营销企划" })).toMatchObject({ ok: false, error: expect.stringContaining("分满了") });
    await setSetting(企划线索计数key, false);
    expect(await 分配线索({ leadId: await 建线索("B"), toUserId: 内贸, kind: "营销企划" })).toEqual({ ok: true });
    expect((await prisma.entLeadAssign.findFirstOrThrow()).counted).toBe(false);
  });

  it("本月分配情况：分配的人看全部能接的人，上级只看自己能设配额的", async () => {
    await 设配额(外贸, 5);
    当(市场);
    await 分配线索({ leadId: await 建线索("A"), toUserId: 外贸 });
    const 全 = (await 本月分配情况())!;
    expect(全.map((r) => r.userId).sort()).toEqual([销售经理, 虚线经理, 内贸, 外贸, 两边].sort());
    expect(全.find((r) => r.userId === 外贸)).toMatchObject({ 已分: 1, 配额: 5, line: "外贸" });
    当(虚线经理);
    expect((await 本月分配情况())!.map((r) => r.userId)).toEqual([外贸]);
  });
});

describe("分出去以后原负责人仍能看到转化情况", () => {
  beforeEach(() => 开());

  it("我分出去的线索带当前状态、接手人；同一条分几次只留最近一次；删了的跳过", async () => {
    当(市场);
    const a = await 建线索("A");
    const b = await 建线索("B");
    await 分配线索({ leadId: a, toUserId: 内贸 });
    await 分配线索({ leadId: b, toUserId: 外贸 });
    当(老板, "ADMIN");
    await 分配线索({ leadId: a, toUserId: 两边 }); // 老板再转一次：from = 内贸
    await prisma.lead.update({ where: { id: a }, data: { status: "已转化", convertedAt: new Date() } });
    当(市场);
    const 我的 = (await 我分出去的线索())!;
    expect(我的.map((x) => x.name).sort()).toEqual(["A", "B"]);
    const A = 我的.find((x) => x.leadId === a)!;
    // 市场人员的那条记录是 A → 内贸；最近一次（老板转的）不是他分的，所以他看到的接手人是内贸，当前负责人是两边
    expect(A).toMatchObject({ status: "已转化", 接手人: "内贸小王", 当前负责人: "两边小赵" });
    expect(A.convertedAt).not.toBeNull();
    expect(A).not.toHaveProperty("phone");
    await prisma.lead.delete({ where: { id: b } });
    expect((await 我分出去的线索())!.map((x) => x.name)).toEqual(["A"]);
  });
});
