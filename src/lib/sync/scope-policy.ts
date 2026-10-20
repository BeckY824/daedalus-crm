/** v4 同步的授权元数据。只含编号、归属、关系及字段钟；不含业务内容。
 * 必须先由服务端核查原有记录，再接受新归属。密文里的元数据还须由接收端逐项比对。
 */
import { 同步表 } from "./tables";
import type { 改动 } from "./local";
// 从 canon 取、不从 crypto 取：这个文件手机端（浏览器）也要用，不能牵进 node:crypto
import { 规范串 } from "./canon";
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
/** delSeq：把它删成现在这样的那一包的批次号（deleted 时才有意义；2026-10-14 起记，之前建的索引没有） */
export type 范围索引 = { t: string; k: string; fields: Record<string, string | null>; clocks: Record<string, string>; deleted: boolean; clock: string; routeSeq: number; delSeq?: number };
export type 范围 = { id: string; owners: string[]; public: boolean; routeSeq: number };
/** 只读的记录索引（Map 或叠加视图）：判权限时只查不改 */
export type 范围行表 = { get(key: string): 范围索引 | undefined };
/** 在 rows 上叠一行（不复制整张表：一次推送要判上百包，团队记录可能几万条） */
const 叠加 = (rows: 范围行表, key: string, n: 范围索引): 范围行表 => ({ get: (k) => (k === key ? n : rows.get(k)) });
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
export function 算范围(row: 范围索引, rows: 范围行表, seen = new Set<string>()): 范围 | null {
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
/**
 * 互看（2026-10-20，团队开关「同事之间互相看得到客户」，存在中继 SyncTeamShare）：开着时业务员也能读同事的客户范围。
 * 「personal:」（未归属联系人、没挂客户的线索、认不出对象的操作日志）照旧只给本人
 */
export const 范围可读 = (scope: 范围 | null, accountId: string, owner: boolean, 互看 = false) =>
  !!scope && (owner || scope.public || scope.owners.includes(`acct_${accountId}`) || (互看 && scope.id.startsWith("Customer:")));
/**
 * 互看时同事的客户只许「加跟进」：新建跟进、它的来源 / 关联订单、操作日志。改资料、删、转交、改别人的计划和待办一律不许。
 * 计划、待办不在里面：服务器看不到它们的负责人（范围元数据只有客户编号），建了以后本人也改不了、勾不掉，干脆不让在同事的客户上建
 */
export const 互看可加 = new Set(["FollowUp", "FollowUpSource", "FollowUpOrder", "AuditLog"]);
/** 写权限先核旧范围，再核新范围。转交出去允许，但不能借伪造归属抢其他私客。 */
export function 范围可写(old: 范围索引 | undefined, n: 范围索引, rows: 范围行表, accountId: string, owner: boolean, 互看 = false): boolean {
  if (owner) return true;
  if (本人可写(old, n, rows, accountId)) return true;
  // 互看：同事的客户下只许新建跟进家族的行（重发同一包在收推送时按 eventId 去重，到不了这里）
  if (!互看 || old || n.deleted || !互看可加.has(n.t)) return false;
  for (const [field, table] of Object.entries(范围父表[n.t] ?? {})) {
    const id = n.fields[field]; if (!id) continue;
    const parent = rows.get(行键(table, id));
    if (!parent || !范围可读(算范围(parent, rows), accountId, false, true)) return false;
  }
  return 范围可读(算范围(n, 叠加(rows, 行键(n.t, n.k), n)), accountId, false, true);
}
function 本人可写(old: 范围索引 | undefined, n: 范围索引, rows: 范围行表, accountId: string): boolean {
  if (n.t === "Setting") return false;
  if (n.t === "User") return n.k === `acct_${accountId}`;
  const before = old && 算范围(old, rows);
  if (old && !范围可读(before ?? null, accountId, false)) return false;
  for (const [field, table] of Object.entries(范围父表[n.t] ?? {})) {
    const id = n.fields[field]; if (!id) continue;
    const parent = rows.get(行键(table, id));
    if (!parent || !范围可读(算范围(parent, rows), accountId, false)) return false;
  }
  const after = 算范围(n, 叠加(rows, 行键(n.t, n.k), n));
  if (!after) return false;
  if (!old) return 范围可读(after, accountId, false);
  // 仅客户负责人及私人条目负责人可转交；关联记录不能借更改父链搬进不可读的私客。
  return ["Customer", "UnassignedContact"].includes(n.t) || 范围可读(after, accountId, false);
}
/**
 * 新写的记录挂在已经删掉的客户 / 商机下面（2026-10-19 团队版主动排查）：手机断网记了一笔跟进，这期间老板把客户删了。
 * 原来照收，电脑回放时当孤儿跳过、「没同步上」又不列孤儿——手机显示已同步，哪台电脑都没有，内容等于丢了。
 * 现在拒掉（老板也一样：挂在已删的东西下面谁都看不到），客户端把它转进「被拒」/「待核对」，内容留着。删除包不拦（级联删照常）
 */
export function 挂在已删的上(n: 范围索引, rows: 范围行表): boolean {
  if (n.deleted) return false;
  for (const [field, table] of Object.entries(范围父表[n.t] ?? {})) {
    const id = n.fields[field]; if (!id) continue;
    if (rows.get(行键(table, id))?.deleted) return true;
  }
  return false;
}

/**
 * 一次推送里的一包能不能写（2026-10-14 领取 / 交接修复）。按两种状态各核一次，任一通过即可：
 *  ① 当前：本次请求里前面已接受的包落下之后的状态（原来的逐包规则；本次刚新建 / 刚领到的记录靠它）。
 *  ② 起点视图 start：请求开始时已有的记录取开始时的版本，本次请求里新建的记录取它刚建出来、刚核过的那一版。
 *     这台设备在请求开始那一刻合法持有的权限，同一次请求里转交出去之后仍算数——所以同一次推送里可以
 *     先转交 / 领取、再改那位客户下的计划和操作日志、再附上它的起点快照；换个顺序（先改子记录、后转交）逐包核本来也都能过，
 *     不比原来多给权限。下一次请求一律按那时的状态重新核：转交出去之后就再也写不进来。
 * 不会多给权限的理由：请求开始时不可读的已有记录，本次请求中任何一包都不能让它变可读（改它本身、挂公海、改它的父链都要先可读），
 * 所以 ② 里每一条记录都是这台设备在本次请求某一刻合法可读的版本；伪造归属、借外键塞进别人的私客，两种状态下都不过。
 */
export function 推送可写(start: 范围行表, rows: 范围行表, n: 范围索引, accountId: string, owner: boolean, 互看 = false): boolean {
  if (挂在已删的上(n, rows)) return false;
  if (owner) return true;
  const key = 行键(n.t, n.k);
  return 范围可写(rows.get(key), n, rows, accountId, false, 互看) || 范围可写(start.get(key), n, start, accountId, false, 互看);
}
