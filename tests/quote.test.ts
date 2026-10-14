/**
 * 报价明细（2026-10-03 外贸第 3 块）。
 *   - 整理：整行空着的丢掉；填了一半说清是哪一行；负数、太大的拦
 *   - 保存：带了报价且和上一版不同才另记一版；只改备注不多出一版；清空记一版空的
 *   - 上次报价：跨这个客户的商机按产品名找最近一次，不分大小写；正在编辑的那个商机不算
 *   - 删商机再撤销：历次报价原样回来
 *   - 客户页报价记录、AI 客户画像里看得到
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null },
}));
// 此套件验证高级功能启用时的实现；默认关闭的服务端拒绝由remediation-feature-access单独覆盖。
vi.mock("@/lib/features", async (original) => ({ ...(await original<object>()), 报价明细: true }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人, 造客户 } from "./r2-data-helpers";
import { saveOpportunity, 读报价, 上次报价, deleteOpportunities, restoreOpportunities } from "@/app/(app)/opportunities/actions";
import { 整理报价行, 报价合计, 同一份报价, 一行说法 } from "@/lib/quote";
import { 客户报价记录 } from "@/lib/quote-db";
import { TOOLS } from "@/lib/agent/tools";
import { DEFAULT_BUSINESS } from "@/lib/business-config";

let 我: string;
beforeEach(async () => {
  await resetDb();
  我 = (await 造本人()).id;
  mocks.user = { ...mocks.user, id: 我 };
});
afterAll(async () => { await prisma.$disconnect(); });

const 灯 = { product: "LED 面板灯", spec: "60×60", qty: 2000, unit: "pcs", unitPrice: 3.2 };
const 架 = { product: "安装支架", spec: null, qty: 2000, unit: "set", unitPrice: 0.35 };

async function 新商机(customerId: string, 报价?: unknown, patch: Record<string, unknown> = {}) {
  const r = await saveOpportunity({ name: "询盘", customerId, amount: 7100, stage: "方案报价", status: "OPEN", probability: 50, ownerId: 我, currency: "USD", ...(报价 === undefined ? {} : { 报价 }), ...patch });
  if (!r.ok) throw new Error(r.error);
  return prisma.opportunity.findFirstOrThrow({ where: { customerId }, orderBy: { createdAt: "desc" } });
}
const 改 = (o: { id: string; customerId: string; updatedAt: Date }, 报价?: unknown, patch: Record<string, unknown> = {}) =>
  saveOpportunity({ id: o.id, name: "询盘", customerId: o.customerId, amount: 7100, stage: "方案报价", status: "OPEN", probability: 50, ownerId: 我, ...(报价 === undefined ? {} : { 报价 }), ...patch });

describe("整理和合计", () => {
  it("整行空着的丢掉；产品没写、数量 / 单价是负数的说清是第几行", () => {
    expect(整理报价行([{ product: "", qty: null, unitPrice: null }, 灯])).toEqual({ ok: true, 行: [灯] });
    expect(整理报价行([灯, { product: "", qty: 5, unitPrice: 1 }])).toEqual({ ok: false, error: "第 2 行没写产品" });
    expect(整理报价行([{ ...灯, qty: -1 }])).toMatchObject({ ok: false, error: expect.stringContaining("第 1 行的数量") });
    expect(整理报价行([{ ...灯, unitPrice: "abc" }])).toMatchObject({ ok: false, error: expect.stringContaining("第 1 行的单价") });
    expect(整理报价行(Array.from({ length: 51 }, () => 灯))).toMatchObject({ ok: false });
    expect(整理报价行("不是数组")).toEqual({ ok: true, 行: [] });
  });

  it("文本去空格、空串变 null；带千分位的字符串数也认", () => {
    expect(整理报价行([{ product: "  灯 ", spec: " ", qty: "1,000", unit: "", unitPrice: "0.035" }])).toEqual({
      ok: true, 行: [{ product: "灯", spec: null, qty: 1000, unit: null, unitPrice: 0.035 }],
    });
  });

  it("合计逐行先算小计再加，留到分", () => {
    expect(报价合计([灯, 架])).toBe(7100);
    expect(报价合计([{ qty: 3, unitPrice: 0.333 }])).toBe(1);
    expect(同一份报价({ currency: "USD", 行: [灯] }, { currency: "USD", 行: [{ ...灯 }] })).toBe(true);
    expect(同一份报价({ currency: "USD", 行: [灯] }, { currency: "EUR", 行: [灯] })).toBe(false);
    expect(一行说法(灯)).toBe("LED 面板灯（60×60） 2000 pcs × 3.2");
  });
});

describe("保存：改价另记一版，不覆盖", () => {
  it("新建带报价：记一版，币种是商机的币种", async () => {
    const c = await 造客户(我);
    const o = await 新商机(c.id, [灯, 架]);
    const qs = await 读报价(o.id);
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ currency: "USD", 合计: 7100, 行: [灯, 架] });
  });

  it("没带报价（老界面、AI 建议卡）不碰报价；只改备注、报价不变也不多出一版", async () => {
    const c = await 造客户(我);
    const o = await 新商机(c.id, [灯]);
    expect((await 改(o, undefined, { remark: "催一下" })).ok).toBe(true);
    expect((await 改(o, [灯], { remark: "又催" })).ok).toBe(true);
    expect(await prisma.quote.count()).toBe(1);
  });

  it("改了单价另记一版，旧的原样留着；新的在前", async () => {
    const c = await 造客户(我);
    const o = await 新商机(c.id, [灯]);
    await new Promise((r) => setTimeout(r, 5));
    expect((await 改(o, [{ ...灯, unitPrice: 3.05 }])).ok).toBe(true);
    const qs = await 读报价(o.id);
    expect(qs.map((q) => q.行[0].unitPrice)).toEqual([3.05, 3.2]);
  });

  it("清空明细记一版空的；从没报过价、这次也空，不记", async () => {
    const c = await 造客户(我);
    const 空 = await 新商机(c.id, []);
    expect(await 读报价(空.id)).toEqual([]);
    const o = await 新商机(c.id, [灯], { name: "第二个" });
    expect((await 改(o, [])).ok).toBe(true);
    const qs = await 读报价(o.id);
    expect(qs.map((q) => q.行.length)).toEqual([0, 1]);
  });

  it("填了一半的行拦下，商机本身也不存", async () => {
    const c = await 造客户(我);
    const r = await saveOpportunity({ name: "x", customerId: c.id, amount: 1, stage: "初步沟通", status: "OPEN", probability: 20, ownerId: 我, 报价: [{ product: "", qty: 1, unitPrice: 2 }] });
    expect(r).toEqual({ ok: false, error: "第 1 行没写产品" });
    expect(await prisma.opportunity.count()).toBe(0);
  });

  it("记一版报价留一条日志，金额带币种", async () => {
    const c = await 造客户(我);
    await 新商机(c.id, [灯, 架]);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { summary: { contains: "报价" } } });
    expect(log.summary).toBe("给商机「询盘」报价：2 行，合计 US$ 7,100");
  });
});

describe("上次报价", () => {
  it("跨这个客户的商机找最近一次，产品名不分大小写、不管多余空格", async () => {
    const c = await 造客户(我);
    await 新商机(c.id, [{ ...灯, product: "LED Panel", unitPrice: 3.4 }], { name: "去年那单" });
    await new Promise((r) => setTimeout(r, 5));
    await 新商机(c.id, [{ ...灯, product: "led  panel", unitPrice: 3.2 }], { name: "今年这单" });
    const 新的 = await 新商机(c.id, undefined, { name: "正在录的" });
    expect(await 上次报价(c.id, " LED panel", 新的.id)).toMatchObject({ unitPrice: 3.2, currency: "USD", unit: "pcs", 商机: "今年这单" });
  });

  it("别的客户报的不算；正在编辑的这个商机自己的报价不算", async () => {
    const 甲 = await 造客户(我);
    const 乙 = await 造客户(我);
    const o = await 新商机(甲.id, [灯]);
    expect(await 上次报价(乙.id, 灯.product)).toBeNull();
    expect(await 上次报价(甲.id, 灯.product, o.id)).toBeNull();
    expect(await 上次报价(甲.id, "")).toBeNull();
  });
});

describe("删商机再撤销 / 客户页 / AI", () => {
  it("撤销删除：历次报价连日期一起回来", async () => {
    const c = await 造客户(我);
    const o = await 新商机(c.id, [灯]);
    await new Promise((r) => setTimeout(r, 5));
    await 改(o, [灯, 架]);
    const 原 = await 读报价(o.id);
    const 删 = await deleteOpportunities([o.id]);
    if (!删.ok) throw new Error("删不掉");
    expect(await prisma.quote.count()).toBe(0);
    expect((await restoreOpportunities(删.快照)).ok).toBe(true);
    const 回 = await 读报价(o.id);
    expect(回.map((q) => ({ at: q.quotedAt, 行: q.行 }))).toEqual(原.map((q) => ({ at: q.quotedAt, 行: q.行 })));
  });

  it("撤销时快照里坏掉的一版跳过，商机照样回来", async () => {
    const c = await 造客户(我);
    const o = await 新商机(c.id, [灯]);
    const 删 = await deleteOpportunities([o.id]);
    if (!删.ok) throw new Error("删不掉");
    const 坏 = 删.快照.map((x) => ({ ...x, 报价: [{ quotedAt: "不是日期", currency: "USD", 行: [灯] }, { quotedAt: new Date().toISOString(), currency: "USD", 行: [{ ...灯, qty: -5 }] }] }));
    expect((await restoreOpportunities(坏)).ok).toBe(true);
    expect(await prisma.opportunity.count()).toBe(1);
    expect(await prisma.quote.count()).toBe(0);
  });

  it("客户页报价记录：每一行带商机名、状态、日期，新的在前", async () => {
    const c = await 造客户(我);
    await 新商机(c.id, [灯], { name: "第一单" });
    await new Promise((r) => setTimeout(r, 5));
    await 新商机(c.id, [架], { name: "第二单", stage: "赢单成交", status: "WON", probability: 100 });
    const 记 = await 客户报价记录(c.id);
    expect(记.map((r) => [r.product, r.商机, r.状态])).toEqual([["安装支架", "第二单", "WON"], ["LED 面板灯", "第一单", "OPEN"]]);
  });

  it("AI：客户画像里商机带当前报价，列商机带报价明细", async () => {
    const c = await 造客户(我);
    await 新商机(c.id, [灯]);
    const ctx = { userId: 我, userName: "我", b: DEFAULT_BUSINESS, recordOffset: 0, proposals: [] };
    const 画像 = await TOOLS.find((t) => t.name === "get_customer")!.run({ id: c.id }, ctx);
    expect(JSON.stringify(画像.data)).toContain("报价（USD）：LED 面板灯（60×60） 2000 pcs × 3.2");
    const 列 = await TOOLS.find((t) => t.name === "list_opportunities")!.run({}, ctx);
    expect((列.data as { 商机: { 报价明细?: string[] }[] }).商机[0].报价明细).toEqual(["LED 面板灯（60×60） 2000 pcs × 3.2"]);
  });
});
