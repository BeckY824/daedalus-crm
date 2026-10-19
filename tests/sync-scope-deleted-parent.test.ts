/**
 * 挂在已删客户 / 商机下面的新记录一律拒（2026-10-19 团队版主动排查，tests/team-qa-sync.test.ts G 段是走真同步的那条）。
 * 老板也拒：挂在已删的东西下面谁都看不到；删除包照收（级联删）
 */
import { expect, it } from "vitest";
import { 挂在已删的上, 推送可写, 行键, type 范围索引 } from "@/lib/sync/scope-policy";

const 行 = (t: string, k: string, fields: Record<string, string | null>, deleted = false): 范围索引 => ({ t, k, fields, clocks: {}, deleted, clock: "1", routeSeq: 0 });
const 表 = (...xs: 范围索引[]) => { const m = new Map(xs.map((x) => [行键(x.t, x.k), x])); return { get: (k: string) => m.get(k) }; };

const 活客户 = 行("Customer", "c1", { salesOwnerId: "acct_li", channelOwnerId: null });
const 删客户 = 行("Customer", "c1", { salesOwnerId: "acct_li", channelOwnerId: null }, true);
const 跟进 = 行("FollowUp", "f1", { customerId: "c1", opportunityId: null });

it("客户还在：业务员、老板都能写", () => {
  expect(推送可写(表(活客户), 表(活客户), 跟进, "li", false)).toBe(true);
  expect(推送可写(表(活客户), 表(活客户), 跟进, "boss", true)).toBe(true);
});

it("客户删了：业务员、老板都写不进；删除包照收", () => {
  expect(挂在已删的上(跟进, 表(删客户))).toBe(true);
  expect(推送可写(表(删客户), 表(删客户), 跟进, "li", false)).toBe(false);
  expect(推送可写(表(删客户), 表(删客户), 跟进, "boss", true)).toBe(false);
  expect(推送可写(表(删客户), 表(删客户), { ...跟进, deleted: true }, "boss", true)).toBe(true);
});

it("挂的商机删了也拒", () => {
  const 商机 = 行("Opportunity", "o1", { customerId: "c1" }, true);
  expect(挂在已删的上({ ...跟进, fields: { customerId: "c1", opportunityId: "o1" } }, 表(活客户, 商机))).toBe(true);
});
