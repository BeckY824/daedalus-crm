/**
 * 二轮排查（r2-data）· 输入边界。
 *
 * 超长、表情、全角、前后空格、只有空格、引号换行 <script> SQL 字样、金额 0 / 负 / 小数 / 超大、
 * 日期边界、手机号各种写法——直接打真实的 Server Action，看存进去的是什么、拦没拦、拦的话说的什么。
 * 表单那一层（antd 的 required）**不拦只有空格的值**（没有 whitespace: true），所以服务端是最后一道。
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
import { saveCustomer, saveContract, patchCustomer, checkDuplicate } from "@/app/(app)/customers/actions";
import { saveFollowUp, saveTask, savePlan, saveContact } from "@/app/(app)/customers/[id]/actions";
import { saveOpportunity } from "@/app/(app)/opportunities/actions";
import { saveLead, convertLead } from "@/app/(app)/leads/actions";
import { saveChannel } from "@/app/(app)/channels/actions";
import { 客户筛选条件 } from "@/app/(app)/customers/query";

let 我: string;
beforeEach(async () => {
  await resetDb();
  我 = (await 造本人()).id;
  mocks.user = { ...mocks.user, id: 我 };
});
afterAll(async () => { await prisma.$disconnect(); });

const 新客户 = (patch: Partial<Parameters<typeof saveCustomer>[0]> = {}) =>
  saveCustomer({
    name: "王强", phone: "13800001111", school: null, grade: null, major: null, followStatus: "待跟进",
    decisionStatus: "了解中", expectedSignAt: null, remark: null, salesOwnerId: 我, channelId: null, referrerCustomerId: null,
    ...patch,
  });

const 搜 = async (keyword: string) =>
  (await prisma.customer.findMany({ where: await 客户筛选条件({ keyword }), select: { name: true } })).map((c) => c.name).sort();

/* ------------------------------------------------------------------ */

describe("文本：空格、超长、表情、特殊字符", () => {
  it("前后空格去掉；全角空格也算空格", async () => {
    const r = await 新客户({ name: "  王强　", remark: "  下周回电  " });
    if (!r.ok) throw new Error(r.error);
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: r.id } });
    expect([c.name, c.remark]).toEqual(["王强", "下周回电"]);
  });

  it("【B】姓名只有空格：服务端应拦下（现状存出一位没有名字的客户）", async () => {
    const r = await 新客户({ name: "   " });
    expect(r.ok, "存进去了一位 name 为空串的客户").toBe(false);
  });

  it("【B】其余几样「名称」只有空格：线索、商机、渠道、联系人、待办、计划都应拦下", async () => {
    const c = await 造客户(我);
    const 各个 = {
      线索: await 结局(saveLead({ name: "  ", source: "微信", status: "待跟进" })),
      商机: await 结局(saveOpportunity({ name: "  ", customerId: c.id, amount: 1, stage: "初步沟通", status: "OPEN", probability: 20, ownerId: 我 })),
      渠道: await 结局(saveChannel({ name: "  ", phone: null, remark: null, channelOwnerId: 我 })),
      联系人: await 结局(saveContact({ customerId: c.id, name: "  ", isPrimary: false })),
      待办: await 结局(saveTask({ customerId: c.id, title: "  " })),
      计划: await 结局(savePlan({ customerId: c.id, subject: "  ", plannedAt: new Date().toISOString(), method: "电话沟通" })),
    };
    const 收了的 = Object.entries(各个).filter(([, v]) => !v.抛了 && (v.值 as { ok: boolean }).ok).map(([k]) => k);
    expect(收了的, `这几样存进了空名字：${收了的.join("、")}`).toEqual([]);
  });

  it("超长：10 万字备注、500 字姓名原样存下（库里不截）", async () => {
    const 长 = "长".repeat(100_000);
    const r = await 新客户({ name: "名".repeat(500), remark: 长 });
    if (!r.ok) throw new Error(r.error);
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: r.id } });
    expect([c.name.length, c.remark?.length]).toEqual([500, 100_000]);
  });

  it("表情、引号、换行、<script>、SQL 字样：原样存、原样取，不被吃掉也不被执行", async () => {
    const 怪 = `王强😀👨‍👩‍👧 "老王" 'O’Brien'\n<script>alert(1)</script>'); DROP TABLE Customer;--`;
    const r = await 新客户({ name: 怪, remark: 怪 });
    if (!r.ok) throw new Error(r.error);
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: r.id } });
    expect(c.name).toBe(怪.trim());
    expect(c.remark).toBe(怪.trim());
    expect(await prisma.customer.count()).toBe(1);
  });

  it("搜索：表情、引号能搜到", async () => {
    await 新客户({ name: "王强😀", phone: "13800000001" });
    await 新客户({ name: "李娜\"小李\"", phone: "13800000002" });
    expect(await 搜("😀")).toEqual(["王强😀"]);
    expect(await 搜('"小李"')).toEqual(['李娜"小李"']);
  });

  it("【C】搜索：% 和 _ 当普通字符，不当通配符", async () => {
    await 新客户({ name: "满意度100%", phone: "13800000001" });
    await 新客户({ name: "100分客户", phone: "13800000002" });
    await 新客户({ name: "a_b", phone: "13800000003" });
    await 新客户({ name: "axb", phone: "13800000004" });
    expect({ "100%": await 搜("100%"), a_b: await 搜("a_b") }).toEqual({ "100%": ["满意度100%"], a_b: ["a_b"] });
  });
});

describe("手机号（表单 / 查重这条路）", () => {
  it("全角数字、空格横杠、+86、带字：规整成同一个号，查重认得出", async () => {
    await 新客户({ phone: "13800001111" });
    for (const v of ["１３８００００１１１１", "138 0000 1111", "+86-138-0000-1111", "13800001111（微信同号）"]) {
      expect(await checkDuplicate(v), v).not.toBeNull();
      const r = await 新客户({ name: "又一个", phone: v });
      expect(r.ok, v).toBe(false);
    }
  });

  it("【A】全角横杠的号码：查重认不出、能建出第二位", async () => {
    await 新客户({ phone: "13800001111" });
    const r = await 新客户({ name: "又一个", phone: "138－0000－1111" });
    expect(r.ok, "同一个号码用全角横杠写一遍就能再建一位（库里存的是原样的「138－0000－1111」）").toBe(false);
  });

  it("海外号、座机分机、打码号、只有空格", async () => {
    expect((await 新客户({ phone: "+1 (415) 555-0123" })).ok).toBe(true);
    expect((await 新客户({ phone: "0755-12345678 转 801", name: "座机" })).ok).toBe(true);
    expect(await 新客户({ phone: "138****1111", name: "打码" })).toMatchObject({ ok: false });
    expect(await 新客户({ phone: "   ", name: "空" })).toMatchObject({ ok: false, error: "请输入联系电话" });
    const 存的 = (await prisma.customer.findMany({ orderBy: { createdAt: "asc" } })).map((c) => c.phone);
    expect(存的).toEqual(["+14155550123", "075512345678"]);
  });

  it("线索转客户：线索上的号码带全角数字 / 空格也能转，转过去是规整后的号", async () => {
    await saveLead({ name: "海川外贸", contact: "王总", phone: "１３８ ００００ １１１１", source: "微信", status: "待跟进" });
    const l = await prisma.lead.findFirstOrThrow();
    const r = await convertLead(l.id);
    if (!r.ok) throw new Error(r.error);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: r.customerId } })).phone).toBe("13800001111");
  });
});

describe("金额", () => {
  it("签约：0、负数、NaN 拦下", async () => {
    const c = await 造客户(我);
    for (const amount of [0, -1, NaN, Infinity]) {
      const r = await saveContract({ customerId: c.id, amount, signedAt: new Date(), remark: null });
      expect(r.ok, String(amount)).toBe(false);
    }
  });

  it("【C】签约：0.4 元过了「必须为正数」，四舍五入后存成 ¥0", async () => {
    const c = await 造客户(我);
    const r = await saveContract({ customerId: c.id, amount: 0.4, signedAt: new Date(), remark: null });
    const k = await prisma.contract.findFirst();
    expect(r.ok === false || (k?.amount ?? 0) > 0, `存成了 ¥${k?.amount}`).toBe(true);
  });

  it("签约：小数四舍五入到元", async () => {
    const c = await 造客户(我);
    await saveContract({ customerId: c.id, amount: 19800.6, signedAt: new Date(), remark: null });
    expect((await prisma.contract.findFirstOrThrow()).amount).toBe(19801);
  });

  it("【B】签约：超过 21.47 亿（Int 上限）直接抛数据库错误，应说一句", async () => {
    const c = await 造客户(我);
    const r = await 结局(saveContract({ customerId: c.id, amount: 3_000_000_000, signedAt: new Date(), remark: null }));
    expect(r.抛了, r.抛了 ? r.错 : "").toBe(false);
  });

  it("签约：两笔各 15 亿，合计超过 Int 上限时首页「本月签约」的聚合不炸", async () => {
    const c = await 造客户(我);
    await prisma.contract.createMany({ data: [{ customerId: c.id, amount: 1_500_000_000, signedAt: new Date() }, { customerId: c.id, amount: 1_500_000_000, signedAt: new Date() }] });
    const r = await 结局(prisma.contract.aggregate({ _sum: { amount: true } }));
    expect(r.抛了, r.抛了 ? r.错 : "").toBe(false);
    if (!r.抛了) expect(r.值._sum.amount).toBe(3_000_000_000);
  });

  it("商机：0 收、负数拦、超大收、小数四舍五入", async () => {
    const c = await 造客户(我);
    const 存 = (amount: number) => saveOpportunity({ name: "x", customerId: c.id, amount, stage: "初步沟通", status: "OPEN", probability: 20, ownerId: 我 });
    expect((await 存(0)).ok).toBe(true);
    expect((await 存(-5)).ok).toBe(false);
    expect((await 存(1e12)).ok).toBe(true);
    expect((await 存(12.5)).ok).toBe(true);
    const 金额 = (await prisma.opportunity.findMany({ orderBy: { createdAt: "asc" } })).map((o) => o.amount);
    expect(金额).toEqual([0, 1e12, 13]);
  });

  it("商机：成交概率填了小数（33.3）不抛，存成整数", async () => {
    const c = await 造客户(我);
    const r = await 结局(saveOpportunity({ name: "x", customerId: c.id, amount: 1, stage: "初步沟通", status: "OPEN", probability: 33.3, ownerId: 我 }));
    expect(r.抛了, r.抛了 ? r.错 : "").toBe(false);
    expect(Number.isInteger((await prisma.opportunity.findFirstOrThrow()).probability)).toBe(true);
  });
});

describe("日期与时长", () => {
  it("【C】行内改「预计签约」传了不存在的日子（2026-02-30）：应拦，现状悄悄存成 3 月 2 日", async () => {
    const c = await 造客户(我);
    const r = await patchCustomer(c.id, "expectedSignAt", "2026-02-30");
    const 现 = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(r.ok === false || 现.expectedSignAt?.getMonth() === 1, `存成了 ${现.expectedSignAt?.toISOString()}`).toBe(true);
  });

  it("跟进时长：负数拦；半分钟存 30 秒", async () => {
    const c = await 造客户(我);
    const 记 = (durationMinutes: number) => saveFollowUp({ customerId: c.id, type: "PHONE", content: "x", status: "已完成", occurredAt: new Date().toISOString(), durationMinutes });
    expect((await 记(-1)).ok).toBe(false);
    expect((await 记(0.5)).ok).toBe(true);
    expect((await prisma.followUp.findFirstOrThrow()).duration).toBe(30);
  });

  it("【C】跟进时间是坏字符串：应说一句，不该抛", async () => {
    const c = await 造客户(我);
    const r = await 结局(saveFollowUp({ customerId: c.id, type: "PHONE", content: "x", status: "已完成", occurredAt: "不是日期" }));
    expect(r.抛了, r.抛了 ? r.错 : "").toBe(false);
  });

  it("2 月 29 日（闰年）、12 月 31 日 23:59、1 月 1 日 00:00 的计划原样存取", async () => {
    const c = await 造客户(我);
    for (const t of [new Date(2028, 1, 29, 10), new Date(2026, 11, 31, 23, 59), new Date(2027, 0, 1, 0, 0)]) {
      const p = await savePlan({ customerId: c.id, subject: "x", plannedAt: t.toISOString(), method: "电话沟通" });
      expect((await prisma.followPlan.findUniqueOrThrow({ where: { id: p.id } })).plannedAt.getTime()).toBe(t.getTime());
    }
  });
});
