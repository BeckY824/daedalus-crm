/** v4 同步的授权元数据。只含编号、归属、关系及字段钟；不含业务内容。
 * 必须先由服务端核查原有记录，再接受新归属。密文里的元数据还须由接收端逐项比对。
 */
import { 同步表 } from "./tables";
import type { 改动 } from "./local";
import { 规范串 } from "./crypto";
export const 范围字段: Record<string, readonly string[]> = {
  User: [], Setting: [], Channel: [], Supplier: [],
  Customer: ["salesOwnerId", "channelOwnerId"],
  CustomerPool: ["customerId"], CustomerClaim: ["customerId"], CustomerExtra: ["customerId"],
  Contact: ["customerId"], UnassignedContact: ["ownerId"],
  Lead: ["customerId", "ownerId"],
  Opportunity: ["customerId"], OpportunityClose: ["opportunityId"], OpportunityMoney: ["opportunityId"],
  Contract: ["customerId"], ContractOwner: ["contractId"], ContractMoney: ["contractId"], ContractWin: ["opportunityId", "contractId"],
  FollowUp: ["customerId", "opportunityId", "contactId"], FollowUpSource: ["followUpId"],
  Task: ["customerId"], FollowPlan: ["customerId"], AuditLog: ["userId", "entity", "entityId"],
  Quote: ["opportunityId"], QuoteLine: ["quoteId"], SupplierQuote: ["opportunityId"],
  TradeOrder: ["customerId", "opportunityId", "contractId"], TradeOrderNode: ["orderId"], TradeOrderDoc: ["orderId"], TradeOrderPurchase: ["orderId"],
  FollowUpOrder: ["followUpId", "orderId"],
};
export const 范围父表: Record<string, Record<string, string>> = {
  CustomerPool: { customerId: "Customer" }, CustomerClaim: { customerId: "Customer" }, CustomerExtra: { customerId: "Customer" },
  Contact: { customerId: "Customer" }, Lead: { customerId: "Customer" },
  Opportunity: { customerId: "Customer" }, OpportunityClose: { opportunityId: "Opportunity" }, OpportunityMoney: { opportunityId: "Opportunity" },
  Contract: { customerId: "Customer" }, ContractOwner: { contractId: "Contract" }, ContractMoney: { contractId: "Contract" },
  ContractWin: { opportunityId: "Opportunity", contractId: "Contract" },
  FollowUp: { customerId: "Customer", opportunityId: "Opportunity", contactId: "Contact" }, FollowUpSource: { followUpId: "FollowUp" },
  Task: { customerId: "Customer" }, FollowPlan: { customerId: "Customer" },
  Quote: { opportunityId: "Opportunity" }, QuoteLine: { quoteId: "Quote" }, SupplierQuote: { opportunityId: "Opportunity" },
  TradeOrder: { customerId: "Customer", opportunityId: "Opportunity", contractId: "Contract" },
  TradeOrderNode: { orderId: "TradeOrder" }, TradeOrderDoc: { orderId: "TradeOrder" }, TradeOrderPurchase: { orderId: "TradeOrder" },
  FollowUpOrder: { followUpId: "FollowUp", orderId: "TradeOrder" },
};
export type 范围元数据 = Pick<改动, "t" | "k" | "o" | "h"> & { fields: Record<string, string | null> };
export type 范围索引 = { t: string; k: string; fields: Record<string, string | null>; clocks: Record<string, string>; deleted: boolean; clock: string; routeSeq: number };
export type 范围 = { id: string; owners: string[]; public: boolean; routeSeq: number };
export const 行键 = (t: string, k: string) => `${t}:${k}`;
const 编号 = (s: unknown): s is string => typeof s === "string" && /^[\w-]{1,100}$/.test(s);
export function 提取范围(e: 改动): 范围元数据 {
  if (!(同步表 as readonly string[]).includes(e.t) || !编号(e.k) || !/^(I|U|D)$/.test(e.o) || !/^\d{13,16}-[\w-]{1,100}$/.test(e.h)) throw Error("范围事件格式不对");
  const fields: 范围元数据["fields"] = {};
  if (e.o !== "D") for (const key of 范围字段[e.t]) {
    if (e.o === "U" && !e.c.includes(key)) continue;
    const v = e.r?.[key] ?? null;
    if (v !== null && !编号(v)) throw Error("范围引用格式不对");
    fields[key] = v as string | null;
  }
  return { t: e.t, k: e.k, o: e.o, h: e.h, fields };
}
export function 核对范围(meta: 范围元数据, e: 改动): boolean {
  try { return 规范串(提取范围(e)) === 规范串(meta); } catch { return false; }
}
/** 路由字段也按原来的字段钟合并；较早的离线整行不能覆盖较新的负责人。 */
export function 合并范围(old: 范围索引 | undefined, meta: 范围元数据, seq: number): 范围索引 {
  const n: 范围索引 = old ? { ...old, fields: { ...old.fields }, clocks: { ...old.clocks } } : { t: meta.t, k: meta.k, fields: {}, clocks: {}, deleted: false, clock: "", routeSeq: 0 };
  if (meta.h > n.clock) { n.deleted = meta.o === "D"; n.clock = meta.h; }
  if (meta.o !== "D") for (const [key, value] of Object.entries(meta.fields)) {
    if (!n.clocks[key] || meta.h > n.clocks[key]) {
      if (old && key in n.fields && n.fields[key] !== value) n.routeSeq = Math.max(n.routeSeq, seq);
      n.fields[key] = value; n.clocks[key] = meta.h;
    }
  }
  return n;
}
/** 所有必需父链须能解析，双重关联须在同一客户下。未知或循环关系一律拒绝。 */
export function 算范围(row: 范围索引, rows: Map<string, 范围索引>, seen = new Set<string>()): 范围 | null {
  const key = 行键(row.t, row.k);
  if (seen.has(key) || seen.size > 12) return null;
  const next = new Set(seen).add(key);
  if (["User", "Setting", "Channel", "Supplier"].includes(row.t)) return { id: "team", owners: [], public: true, routeSeq: row.routeSeq };
  if (row.t === "Customer") {
    const pool = rows.get(行键("CustomerPool", row.k));
    return { id: key, owners: [row.fields.salesOwnerId, row.fields.channelOwnerId].filter((x): x is string => !!x), public: !!pool && !pool.deleted, routeSeq: row.routeSeq };
  }
  if (row.t === "UnassignedContact" || (row.t === "Lead" && !row.fields.customerId)) return { id: `personal:${row.fields.ownerId ?? 'owner'}`, owners: row.fields.ownerId ? [row.fields.ownerId] : [], public: false, routeSeq: row.routeSeq };
  if (row.t === "AuditLog") {
    const target = row.fields.entity && row.fields.entityId && rows.get(行键(row.fields.entity, row.fields.entityId));
    if (target) return 算范围(target, rows, next);
    // 未识别的业务对象可能包含客户摘要，不能当作全队共享日志。
    return { id: `personal:${row.fields.userId ?? 'owner'}`, owners: row.fields.userId ? [row.fields.userId] : [], public: false, routeSeq: row.routeSeq };
  }
  const parents = 范围父表[row.t];
  if (!parents) return null;
  const scopes: 范围[] = [];
  for (const [field, table] of Object.entries(parents)) {
    const id = row.fields[field]; if (!id) continue;
    const parent = rows.get(行键(table, id));
    const scope = parent && 算范围(parent, rows, next);
    if (!scope) return null;
    scopes.push(scope);
  }
  if (!scopes.length || scopes.some(s => s.id !== scopes[0].id)) return null;
  return { ...scopes[0], routeSeq: Math.max(row.routeSeq, ...scopes.map(s => s.routeSeq)) };
}
export const 范围可读 = (scope: 范围 | null, accountId: string, owner: boolean) => !!scope && (owner || scope.public || scope.owners.includes(`acct_${accountId}`));
/** 写权限先核旧范围，再核新范围。转交出去允许，但不能借伪造归属抢其他私客。 */
export function 范围可写(old: 范围索引 | undefined, n: 范围索引, rows: Map<string, 范围索引>, accountId: string, owner: boolean): boolean {
  if (owner) return true;
  if (n.t === "Setting") return false;
  if (n.t === "User") return n.k === `acct_${accountId}`;
  const before = old && 算范围(old, rows);
  if (old && !范围可读(before ?? null, accountId, false)) return false;
  for (const [field, table] of Object.entries(范围父表[n.t] ?? {})) {
    const id = n.fields[field]; if (!id) continue;
    const parent = rows.get(行键(table, id));
    if (!parent || !范围可读(算范围(parent, rows), accountId, false)) return false;
  }
  const afterRows = new Map(rows).set(行键(n.t, n.k), n);
  const after = 算范围(n, afterRows);
  if (!after) return false;
  if (!old) return 范围可读(after, accountId, false);
  // 仅客户负责人及私人条目负责人可转交；关联记录不能借更改父链搬进不可读的私客。
  return ["Customer", "UnassignedContact"].includes(n.t) || 范围可读(after, accountId, false);
}
