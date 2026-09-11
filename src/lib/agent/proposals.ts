/**
 * 写入提议：AI 能提，但落不了库。
 *
 * agent 的工具全部只读，唯一能碰数据的路径是「提议 → 人在卡片上确认 → 调原有的 server action」。
 *
 * 一条重要的分寸：**信息不全不是拒绝的理由**。模型只知道「新建一条线索 吴小雯」时，
 * 正确做法是给一张只填了姓名、其余留空的卡片让人补，而不是在对话里让人照格式打一遍字。
 * 所以这里把"不合法"和"还没填"分开：
 *   不合法（状态值不存在、日期给了但解析不了）→ 当场拒绝，让模型重说
 *   还没填（必填项是空的）                    → 照样出卡片，由 missingFields 拦住确认按钮
 * 校验放在纯函数里，生成时和落库时各跑一遍——卡片上的值人能改，改完的同样不可信。
 */
import { FOLLOW_TYPES, FOLLOW_TYPE_MAP, FOLLOW_METHODS, FOLLOW_STATUSES, DECISION_STATUSES, LEAD_STATUSES } from "../constants";
import type { BusinessConfig } from "../business-config";
import { dayjs } from "../utils";

export type ProposalKind = "set_status" | "add_followup" | "add_plan" | "add_lead";

type Base = {
  /** 前端按它认卡片；同一轮对话内唯一 */
  id: string;
  /** 新建线索时没有客户，为空 */
  customerId: string;
  customerName: string;
  /** 一句话：为什么建议这么做。给人判断用，不写进库 */
  reason: string;
};

export type Proposal =
  | (Base & { kind: "set_status"; field: "followStatus" | "decisionStatus"; to: string })
  | (Base & { kind: "add_followup"; type: string; title: string; content: string; occurredAt: string })
  | (Base & { kind: "add_plan"; subject: string; plannedAt: string; method: string })
  | (Base & { kind: "add_lead"; name: string; contact: string; phone: string; source: string; status: string; remark: string });

export type ProposalResult = { ok: true; proposal: Proposal } | { ok: false; error: string };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** 模型爱写「2026-09-12 19:00」这类。给了但解析不了要报错；没给就留空让人挑 */
function parseWhen(v: unknown): { ok: true; at: string } | { ok: false } {
  const s = str(v, 40);
  if (!s) return { ok: true, at: "" };
  const d = dayjs(s.replace(/\//g, "-").replace(/[年月]/g, "-").replace(/日/g, ""));
  return d.isValid() ? { ok: true, at: d.toISOString() } : { ok: false };
}

/** 跟进类型：模型可能给「电话沟通」也可能给「PHONE」，两种都收 */
function normalizeFollowType(v: unknown): string | null {
  const s = str(v, 20);
  if (!s) return null;
  if (FOLLOW_TYPE_MAP[s]) return s;
  return FOLLOW_TYPES.find((t) => t.label === s)?.value ?? null;
}

/** 枚举值：给了就必须对；没给就用默认值 */
function pickEnum(v: unknown, allowed: readonly string[], fallback: string): { ok: true; value: string } | { ok: false } {
  const s = str(v, 20);
  if (!s) return { ok: true, value: fallback };
  return allowed.includes(s) ? { ok: true, value: s } : { ok: false };
}

export function buildProposal(
  id: string,
  kind: ProposalKind,
  customer: { id: string; name: string },
  args: Record<string, unknown>,
  b: Pick<BusinessConfig, "sources">,
): ProposalResult {
  const base = { id, customerId: customer.id, customerName: customer.name, reason: str(args.reason, 120) };
  if (!base.reason) return { ok: false, error: "reason 必填：用一句话说明为什么建议这么做" };

  if (kind === "set_status") {
    const to = str(args.to, 20);
    const isFollow = (FOLLOW_STATUSES as readonly string[]).includes(to);
    const isDecision = (DECISION_STATUSES as readonly string[]).includes(to);
    if (to && !isFollow && !isDecision) {
      return { ok: false, error: `「${to}」不是合法状态。跟进状态：${FOLLOW_STATUSES.join("/")}；决策状态：${DECISION_STATUSES.join("/")}` };
    }
    return { ok: true, proposal: { ...base, kind, field: isDecision ? "decisionStatus" : "followStatus", to } };
  }

  if (kind === "add_followup") {
    const type = normalizeFollowType(args.type) ?? "";
    if (args.type && !type) return { ok: false, error: `type 必须是这几种之一：${FOLLOW_TYPES.map((t) => t.label).join("/")}` };
    const when = parseWhen(args.occurredAt);
    if (!when.ok) return { ok: false, error: "occurredAt 解析不了，用 YYYY-MM-DD HH:mm" };
    return {
      ok: true,
      // 不给时间就算刚刚发生的——补录一次沟通，默认"现在"几乎总是对的
      proposal: { ...base, kind, type: type || "PHONE", title: str(args.title, 60), content: str(args.content, 2000), occurredAt: when.at || dayjs().toISOString() },
    };
  }

  if (kind === "add_plan") {
    const when = parseWhen(args.plannedAt);
    if (!when.ok) return { ok: false, error: "plannedAt 解析不了，用 YYYY-MM-DD HH:mm" };
    const m = pickEnum(args.method, FOLLOW_METHODS, "");
    if (!m.ok) return { ok: false, error: `method 必须是：${FOLLOW_METHODS.join("/")}` };
    return { ok: true, proposal: { ...base, kind, subject: str(args.subject, 100), plannedAt: when.at, method: m.value } };
  }

  const src = pickEnum(args.source, b.sources, "其他");
  if (!src.ok) return { ok: false, error: `source 必须是：${b.sources.join("/")}` };
  const st = pickEnum(args.status, LEAD_STATUSES, "待跟进");
  if (!st.ok) return { ok: false, error: `status 必须是：${LEAD_STATUSES.join("/")}` };
  return {
    ok: true,
    proposal: {
      ...base,
      kind: "add_lead",
      name: str(args.name, 60),
      contact: str(args.contact, 40),
      phone: str(args.phone, 30),
      source: src.value,
      status: st.value,
      remark: str(args.remark, 500),
    },
  };
}

/**
 * 还差哪些必填项。空数组 = 可以确认。
 * 卡片用它决定「确认」按钮能不能点，服务端用它兜底——前端禁用按钮不算防线。
 */
export function missingFields(p: Proposal): string[] {
  const miss: string[] = [];
  if (p.kind === "set_status" && !p.to) miss.push("新状态");
  if (p.kind === "add_followup" && p.content.trim().length < 4) miss.push("沟通内容");
  if (p.kind === "add_plan") {
    if (!p.subject.trim()) miss.push("谈什么");
    if (!p.plannedAt) miss.push("时间");
    if (!p.method) miss.push("方式");
  }
  if (p.kind === "add_lead" && !p.name.trim()) miss.push("名称");
  return miss;
}

/** 卡片抬头：一句话说清这张卡会改什么 */
export function describeProposal(p: Proposal, customerNoun: string): string {
  if (p.kind === "set_status") {
    const f = p.field === "followStatus" ? "跟进状态" : "决策状态";
    return `把${customerNoun}「${p.customerName}」的${f}改成「${p.to || "…"}」`;
  }
  if (p.kind === "add_followup") return `给「${p.customerName}」记一条${FOLLOW_TYPE_MAP[p.type]?.label ?? p.type}`;
  if (p.kind === "add_plan") return `给「${p.customerName}」排一次${p.method || "跟进"}`;
  return `新建一条线索${p.name ? `「${p.name}」` : ""}`;
}

/** 落库后写进操作日志的那句话 */
export function summarizeApplied(p: Proposal, customerNoun: string): string {
  return `确认 AI 建议：${describeProposal(p, customerNoun)}`;
}
