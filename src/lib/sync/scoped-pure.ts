/**
 * 范围同步里不碰数据库、不碰 node: 模块的那几样（2026-10-15，手机端要和桌面端共用）：
 *   - 主键表：每张同步表的主键列。桌面端从 Prisma 的 DMMF 读，手机端读这张表；tests/sync-scoped-pure.test.ts 核两边一致
 *   - 归一化范围行：服务端当前路由盖掉历史包里过期的路由字段（原在 scoped-local.ts，逻辑一字未改）
 */
import { 行键, type 范围索引 } from "./scope-policy";
import type { 改动 } from "./local";

export const 主键表: Record<string, string> = {
  User: "id", Setting: "key", Channel: "id", Customer: "id",
  CustomerPool: "customerId", CustomerClaim: "customerId", CustomerExtra: "customerId", CustomerMerge: "id", CustomerNotDupe: "id",
  Contact: "id", UnassignedContact: "id", Lead: "id",
  Opportunity: "id", OpportunityClose: "opportunityId", OpportunityMoney: "opportunityId",
  Contract: "id", ContractOwner: "contractId", ContractMoney: "contractId", ContractWin: "opportunityId",
  FollowUp: "id", FollowUpSource: "followUpId", Task: "id", FollowPlan: "id", AuditLog: "id",
  Quote: "id", QuoteLine: "id", Supplier: "id", SupplierQuote: "id",
  TradeOrder: "id", TradeOrderNode: "id", TradeOrderDoc: "id", TradeOrderPurchase: "orderId", FollowUpOrder: "followUpId",
  TradeOrderCheck: "id", TradeOrderTrack: "orderId", TradeOrderNodeOwner: "nodeId",
  Attachment: "id",
};

/** 服务端当前路由覆盖历史包中的过期路由；隐藏推荐人只置空 FK，不复制隐藏客户来满足外键。 */
export function 归一化范围行(e: 改动, current: 范围索引, authorized: Set<string>, 主字段: (t: string) => string = (t) => 主键表[t]): 改动 {
  if (e.o === 'D') return e;
  if (!e.r || String(e.r[主字段(e.t)]) !== e.k) throw Error('密文的记录编号与授权编号不一致');
  const r = { ...e.r, ...current.fields };
  if (e.t === 'Customer') for (const field of ['referrerCustomerId', 'attributionCustomerId']) if (r[field] && !authorized.has(行键('Customer', String(r[field])))) r[field] = null;
  return { ...e, r };
}
