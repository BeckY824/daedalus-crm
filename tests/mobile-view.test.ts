/**
 * 手机库的行 → 界面（lib/mobile/view.ts）：电脑同步来的（毫秒数、0/1）和手机自己记的（毫秒数、true/false）一样读；
 * 「今天」只算我的计划；搜索认电话里的空格和横线。
 */
import { describe, expect, it } from "vitest";
import { 分表, 客户们, 今天要跟, 搜, 毫秒, 真, 国旗 } from "@/lib/mobile/view";
import type { 记录 } from "@/lib/mobile/sync";

const 今早 = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
const 行 = (t: string, r: Record<string, unknown>): 记录 => ({ t, k: String(r.id ?? r.customerId ?? r.opportunityId), r, 钟: {} });
const 我 = "acct_li";
const 数据 = [
  行("User", { id: 我, name: "小李" }), 行("User", { id: "acct_boss", name: "老板" }),
  行("Customer", { id: "c1", name: "Atlas Home", phone: "+1 415-555 0132", salesOwnerId: 我, followStatus: "意向较高" }),
  行("CustomerExtra", { customerId: "c1", country: "美国", whatsapp: "+14155550132" }),
  行("Contact", { id: "k1", customerId: "c1", name: "Maria", position: "采购", isPrimary: 1 }),
  行("FollowUp", { id: "f1", customerId: "c1", ownerId: 我, type: "SMS", content: "旧的", occurredAt: 今早 - 3 * 86400_000 }),
  行("FollowUp", { id: "f2", customerId: "c1", ownerId: "acct_boss", type: "PHONE", content: "老板打的", occurredAt: 今早 - 86400_000 }),
  行("FollowPlan", { id: "p1", customerId: "c1", ownerId: 我, subject: "过期的", plannedAt: 今早 - 86400_000, done: 0 }),
  行("FollowPlan", { id: "p0", customerId: "c1", ownerId: 我, subject: "做完了", plannedAt: 今早 - 5 * 86400_000, done: 1 }),
  行("Opportunity", { id: "o1", customerId: "c1", name: "春季", amount: 186000, stage: "方案报价", status: "OPEN" }),
  行("OpportunityMoney", { opportunityId: "o1", currency: "USD" }),
  行("Customer", { id: "c2", name: "Nordlicht", salesOwnerId: 我 }),
  行("FollowPlan", { id: "p2", customerId: "c2", ownerId: 我, subject: "今天的", plannedAt: 今早 + 15 * 3600_000, done: false }),
  行("Customer", { id: "c3", name: "老板的客户", salesOwnerId: "acct_boss" }),
  行("FollowPlan", { id: "p3", customerId: "c3", ownerId: "acct_boss", subject: "老板的计划", plannedAt: 今早 + 3600_000, done: 0 }),
  行("Customer", { id: "c4", name: "公海客户", salesOwnerId: "acct_boss" }),
  行("CustomerPool", { customerId: "c4", reason: "手动" }),
];

describe("手机界面的数据", () => {
  const cs = 客户们(分表(数据), 我, new Set(["f1"]));
  const c1 = cs.find((c) => c.id === "c1")!;
  it("客户：额外信息、联系人、商机币种、跟进按时间倒序、谁记的、待同步", () => {
    expect(c1).toMatchObject({ country: "美国", whatsapp: "+14155550132", status: "意向较高", 公海: false, 负责人: "我" });
    expect(c1.联系人[0]).toMatchObject({ name: "Maria", title: "采购", 主要: true });
    expect(c1.商机).toMatchObject({ name: "春季", amount: 186000, currency: "USD", stage: "方案报价" });
    expect(c1.跟进.map((x) => [x.id, x.by, x.待同步])).toEqual([["f2", "老板", false], ["f1", "我", true]]);
    expect(c1.计划).toMatchObject({ id: "p1" }); // 做完的（done = 1）不算
    expect(cs.find((c) => c.id === "c4")!.公海).toBe(true);
  });
  it("今天：只算我的计划，公海不算；过期 / 今天分开", () => {
    const t = 今天要跟(cs, 我);
    expect(t.过期.map((c) => c.id)).toEqual(["c1"]);
    expect(t.今天.map((c) => c.id)).toEqual(["c2"]);
    expect([...t.过期, ...t.今天, ...t.之后].map((c) => c.id)).not.toContain("c3");
  });
  it("搜索：名字、国家、联系人；电话忽略空格横线", () => {
    expect(搜(cs, "atlas").map((c) => c.id)).toEqual(["c1"]);
    expect(搜(cs, "美国").map((c) => c.id)).toEqual(["c1"]);
    expect(搜(cs, "maria").map((c) => c.id)).toEqual(["c1"]);
    expect(搜(cs, "4155550132").map((c) => c.id)).toEqual(["c1"]);
    expect(搜(cs, "555 0132").map((c) => c.id)).toEqual(["c1"]);
  });
  it("读值：毫秒数、ISO 字符串、0/1 都认", () => {
    expect(毫秒(1760500000000)).toBe(1760500000000);
    expect(毫秒("1760500000000")).toBe(1760500000000);
    expect(毫秒("2026-10-15T00:00:00.000Z")).toBe(Date.parse("2026-10-15T00:00:00.000Z"));
    expect(毫秒(null)).toBeNull();
    expect([真(1), 真(true), 真("1"), 真(0), 真(false), 真(null)]).toEqual([true, true, true, false, false, false]);
    expect(国旗("美国")).toBe("🇺🇸");
    expect(国旗("火星")).toBe("");
  });
});
