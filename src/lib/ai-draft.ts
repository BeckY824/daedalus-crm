/**
 * AI 产出的清洗与校验。
 *
 * 模型输出永远当不可信输入对待：枚举值可能拼错、id 可能是编的、
 * 时间可能不合法。这里把它们全部收敛到系统认识的取值——
 * 收敛不了的宁可置空让人补填，也不能让脏值进库污染统计。
 * （saveFollowUp 等 Server Action 有自己的校验，这里是第一道闸，
 * 目的是让预填表单里不出现"选不出来"的值。）
 *
 * 纯函数，不碰网络与数据库，便于测试。
 */
import { dayjs } from "@/lib/utils";
import {
  FOLLOW_TYPES,
  FOLLOW_RECORD_STATUSES,
  FOLLOW_METHODS,
  FOLLOW_STATUSES,
  DECISION_STATUSES,
} from "@/lib/constants";

export type FollowUpDraft = {
  followUp: {
    type: string;
    title: string;
    content: string;
    status: string;
    durationMinutes: number | null;
    /** ISO 字符串；模型没给或给的不合法时为 null，由表单默认成"现在" */
    occurredAt: string | null;
    contactId: string | null;
    opportunityId: string | null;
  };
  tasks: { title: string; dueAt: string | null }[];
  plan: { subject: string; plannedAt: string; method: string } | null;
  followStatusSuggestion: string | null;
  decisionStatusSuggestion: string | null;
};

const FOLLOW_TYPE_VALUES = FOLLOW_TYPES.map((t) => t.value);

function asString(v: unknown, maxLen: number): string {
  return typeof v === "string" ? v.trim().slice(0, maxLen) : "";
}

function inEnum<T extends readonly string[]>(v: unknown, allowed: T): T[number] | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? v : null;
}

function asIso(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = dayjs(v);
  if (!d.isValid()) return null;
  // 十年开外的时间基本是模型算错了相对日期，进库只会误导跟进计划
  if (Math.abs(d.diff(dayjs(), "year", true)) > 10) return null;
  return d.toISOString();
}

/**
 * 清洗「跟进速记」的解析结果。
 * @throws 缺少沟通内容时抛错——内容都没有，这次解析就是失败，不该假装成功
 */
export function sanitizeFollowUpDraft(
  raw: unknown,
  ctx: { contactIds: string[]; opportunityIds: string[] },
): FollowUpDraft {
  const r = (raw ?? {}) as Record<string, unknown>;
  const f = (r.followUp ?? {}) as Record<string, unknown>;

  const content = asString(f.content, 2000);
  if (!content) throw new Error("AI 未能从原话中整理出沟通内容，请补充细节后重试或手动填写");

  let durationMinutes: number | null = null;
  if (typeof f.durationMinutes === "number" && Number.isFinite(f.durationMinutes)) {
    const n = Math.round(f.durationMinutes);
    if (n > 0 && n <= 600) durationMinutes = n;
  }

  const tasksRaw = Array.isArray(r.tasks) ? r.tasks : [];
  const tasks = tasksRaw
    .map((t) => {
      const o = (t ?? {}) as Record<string, unknown>;
      return { title: asString(o.title, 200), dueAt: asIso(o.dueAt) };
    })
    .filter((t) => t.title)
    .slice(0, 5);

  let plan: FollowUpDraft["plan"] = null;
  const p = r.plan as Record<string, unknown> | null | undefined;
  if (p && typeof p === "object") {
    const subject = asString(p.subject, 200);
    const plannedAt = asIso(p.plannedAt);
    // 主题和时间缺一个都立不住——没时间的计划等于没计划
    if (subject && plannedAt) {
      plan = { subject, plannedAt, method: inEnum(p.method, FOLLOW_METHODS) ?? "电话沟通" };
    }
  }

  return {
    followUp: {
      type: inEnum(f.type, FOLLOW_TYPE_VALUES) ?? "OTHER",
      title: asString(f.title, 200),
      content,
      status: inEnum(f.status, FOLLOW_RECORD_STATUSES) ?? "已完成",
      durationMinutes,
      occurredAt: asIso(f.occurredAt),
      contactId: typeof f.contactId === "string" && ctx.contactIds.includes(f.contactId) ? f.contactId : null,
      opportunityId:
        typeof f.opportunityId === "string" && ctx.opportunityIds.includes(f.opportunityId) ? f.opportunityId : null,
    },
    tasks,
    plan,
    followStatusSuggestion: inEnum(r.followStatusSuggestion, FOLLOW_STATUSES),
    decisionStatusSuggestion: inEnum(r.decisionStatusSuggestion, DECISION_STATUSES),
  };
}

export type CustomerBrief = {
  /** 这个学员的完整故事线，一小段话 */
  story: string;
  /** 现在卡在哪、上次聊到哪 */
  current: string;
  /** 这次建议谈什么，3~5 条 */
  talkingPoints: string[];
  /** 风险信号，可为空 */
  risks: string[];
};

function asStringList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

/** @throws 连故事线都没有时抛错，让调用方如实报失败 */
export function sanitizeBrief(raw: unknown): CustomerBrief {
  const r = (raw ?? {}) as Record<string, unknown>;
  const story = asString(r.story, 600);
  if (!story) throw new Error("AI 未能生成简报内容，请重试");
  return {
    story,
    current: asString(r.current, 300),
    talkingPoints: asStringList(r.talkingPoints, 5, 120),
    risks: asStringList(r.risks, 3, 120),
  };
}
