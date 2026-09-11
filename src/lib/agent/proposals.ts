/**
 * 写入提议：AI 能提，但落不了库。
 *
 * agent 的工具全部只读，唯一能碰数据的路径是「提议 → 人在卡片上确认 → 调原有的 server action」。
 * 所以这里只做两件事：
 *   1. 把模型给的松散参数收紧成一个合法提议（类型、状态值、日期都得对，错了当场拒绝）
 *   2. 描述这个提议给人看什么（卡片标题、字段名）
 * 校验放在这个纯函数文件里，前端确认时再校验一遍——人可以改卡片上的值，改完的值同样不可信。
 */
import { FOLLOW_TYPES, FOLLOW_TYPE_MAP, FOLLOW_METHODS, FOLLOW_STATUSES, DECISION_STATUSES } from "../constants";
import { dayjs } from "../utils";

export type ProposalKind = "set_status" | "add_followup" | "add_plan";

type Base = {
  /** 前端按它认卡片；同一轮对话内唯一 */
  id: string;
  customerId: string;
  customerName: string;
  /** 一句话：为什么建议这么做。给人判断用，不写进库 */
  reason: string;
};

export type Proposal =
  | (Base & { kind: "set_status"; field: "followStatus" | "decisionStatus"; to: string })
  | (Base & { kind: "add_followup"; type: string; title: string; content: string; occurredAt: string })
  | (Base & { kind: "add_plan"; subject: string; plannedAt: string; method: string });

export type ProposalResult = { ok: true; proposal: Proposal } | { ok: false; error: string };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** 模型爱写「2026-09-12 19:00」「明天下午三点」这类。只认能解析的，解析不了让它重说 */
function parseWhen(v: unknown): string | null {
  const s = str(v, 40);
  if (!s) return null;
  const d = dayjs(s.replace(/\//g, "-").replace(/[年月]/g, "-").replace(/日/g, ""));
  return d.isValid() ? d.toISOString() : null;
}

/** 跟进类型：模型可能给「电话沟通」也可能给「PHONE」，两种都收 */
function normalizeFollowType(v: unknown): string | null {
  const s = str(v, 20);
  if (!s) return null;
  if (FOLLOW_TYPE_MAP[s]) return s;
  return FOLLOW_TYPES.find((t) => t.label === s)?.value ?? null;
}

export function buildProposal(id: string, kind: ProposalKind, customer: { id: string; name: string }, args: Record<string, unknown>): ProposalResult {
  const base = { id, customerId: customer.id, customerName: customer.name, reason: str(args.reason, 120) };
  if (!base.reason) return { ok: false, error: "reason 必填：用一句话说明为什么建议这么做" };

  if (kind === "set_status") {
    const to = str(args.to, 20);
    const isFollow = (FOLLOW_STATUSES as readonly string[]).includes(to);
    const isDecision = (DECISION_STATUSES as readonly string[]).includes(to);
    if (!isFollow && !isDecision) {
      return { ok: false, error: `「${to}」不是合法状态。跟进状态：${FOLLOW_STATUSES.join("/")}；决策状态：${DECISION_STATUSES.join("/")}` };
    }
    return { ok: true, proposal: { ...base, kind, field: isFollow ? "followStatus" : "decisionStatus", to } };
  }

  if (kind === "add_followup") {
    const type = normalizeFollowType(args.type);
    if (!type) return { ok: false, error: `type 必须是这几种之一：${FOLLOW_TYPES.map((t) => t.label).join("/")}` };
    const content = str(args.content, 2000);
    if (content.length < 4) return { ok: false, error: "content 太短，把这次沟通写清楚" };
    // 不给时间就算刚刚发生的
    const occurredAt = parseWhen(args.occurredAt) ?? dayjs().toISOString();
    return { ok: true, proposal: { ...base, kind, type, title: str(args.title, 60), content, occurredAt } };
  }

  const subject = str(args.subject, 100);
  if (subject.length < 2) return { ok: false, error: "subject 必填：下次要谈什么" };
  const plannedAt = parseWhen(args.plannedAt);
  if (!plannedAt) return { ok: false, error: "plannedAt 解析不了，用 YYYY-MM-DD HH:mm" };
  const method = str(args.method, 20);
  if (!(FOLLOW_METHODS as readonly string[]).includes(method)) {
    return { ok: false, error: `method 必须是：${FOLLOW_METHODS.join("/")}` };
  }
  return { ok: true, proposal: { ...base, kind: "add_plan", subject, plannedAt, method } };
}

/** 卡片抬头：一句话说清这张卡会改什么 */
export function describeProposal(p: Proposal, customerNoun: string): string {
  if (p.kind === "set_status") {
    return `把${customerNoun}「${p.customerName}」的${p.field === "followStatus" ? "跟进状态" : "决策状态"}改成「${p.to}」`;
  }
  if (p.kind === "add_followup") {
    return `给「${p.customerName}」记一条${FOLLOW_TYPE_MAP[p.type]?.label ?? p.type}`;
  }
  return `给「${p.customerName}」排一次${p.method}`;
}

/** 落库后写进操作日志的那句话 */
export function summarizeApplied(p: Proposal, customerNoun: string): string {
  return `确认 AI 建议：${describeProposal(p, customerNoun)}`;
}
