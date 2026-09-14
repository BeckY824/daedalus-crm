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
import { FOLLOW_TYPES, FOLLOW_TYPE_MAP, FOLLOW_METHODS, FOLLOW_STATUSES, DECISION_STATUSES, LEAD_STATUSES, GRADES, OPP_STAGES, STAGE_PROBABILITY } from "../constants";
import type { BusinessConfig } from "../business-config";
import { dayjs } from "../utils";

export type ProposalKind = "set_status" | "add_followup" | "add_plan" | "add_lead" | "update_customer" | "add_opportunity" | "add_contract" | "update_channel";

/**
 * 档案里能改的字段。
 *
 * 关系字段（负责人 / 渠道 / 推荐人）这里存的是**名字不是 id**：模型只知道名字，
 * 而且把 id 交给模型意味着它可以编一个出来。名字到 id 的解析放在落库那一步做，
 * 重名时直接报错让人去改，绝不猜——猜错就是把客户挂到别人名下。
 */
export const 可改字段 = {
  name: { label: "姓名", kind: "text" },
  phone: { label: "手机号", kind: "text" },
  school: { label: "院校", kind: "text" },
  grade: { label: "年级", kind: "enum", values: GRADES },
  major: { label: "专业", kind: "text" },
  followStatus: { label: "跟进状态", kind: "enum", values: FOLLOW_STATUSES },
  decisionStatus: { label: "决策状态", kind: "enum", values: DECISION_STATUSES },
  expectedSignAt: { label: "预计签约", kind: "date" },
  remark: { label: "备注", kind: "text" },
  salesOwnerName: { label: "销售负责人", kind: "name" },
  channelName: { label: "来源渠道", kind: "name" },
  referrerName: { label: "推荐人", kind: "name" },
  /** 单独订正这一位的渠道负责人；留空 = 恢复按推荐链。改渠道本身用 propose_channel_update */
  channelOwnerName: { label: "渠道负责人", kind: "name" },
} as const;

export type 可改字段名 = keyof typeof 可改字段;
export const 可改字段名单 = Object.keys(可改字段) as 可改字段名[];
export type 一处改动 = { field: 可改字段名; value: string };

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
  | (Base & { kind: "add_lead"; name: string; contact: string; phone: string; source: string; status: string; remark: string })
  | (Base & { kind: "update_customer"; changes: 一处改动[] })
  | (Base & { kind: "add_opportunity"; name: string; amount: number; stage: string; probability: number; expectedDealAt: string; remark: string })
  | (Base & { kind: "add_contract"; amount: number; signedAt: string; remark: string })
  | (Base & { kind: "update_channel"; channelName: string; ownerName: string; phone: string; remark: string });

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

/** 金额：给了就必须是非负数字；没给记 0，让人在卡片上补 */
function 收金额(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,¥￥\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

/** 成交概率：没给返回 undefined，由阶段推一个默认值 */
function 收概率(v: unknown): number | null | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n);
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

  if (kind === "update_customer") {
    const raw = args.changes;
    if (!raw || typeof raw !== "object") return { ok: false, error: "changes 必填：一个对象，键是字段名、值是要改成什么" };
    /**
     * 两种形状都要认：
     *   模型给的是 {followStatus: "已签约"}
     *   卡片回传的是 [{field:"followStatus", value:"已签约"}]——因为落库前会拿
     *   **已经建好的提议**再校验一遍（人在卡片上改过的值同样不可信）
     * 只认前一种的话，这条重新校验的路会把每张卡都判成"没有「0」这个字段"。
     */
    const 条目: [string, unknown][] = Array.isArray(raw)
      ? (raw as unknown[]).map((x) => {
          const o = (x ?? {}) as Record<string, unknown>;
          return [String(o.field ?? ""), o.value];
        })
      : Object.entries(raw as Record<string, unknown>);
    const changes: 一处改动[] = [];
    for (const [k, v] of 条目) {
      if (!(k in 可改字段)) return { ok: false, error: `没有「${k}」这个字段。能改的是：${可改字段名单.join("、")}` };
      const f = k as 可改字段名;
      const spec = 可改字段[f];
      // 枚举给错当场拒，让模型重说；给空是"还没填"，照样出卡片让人补
      if (spec.kind === "enum") {
        const e = pickEnum(v, spec.values, "");
        if (!e.ok) return { ok: false, error: `${spec.label}必须是：${spec.values.join("/")}` };
        changes.push({ field: f, value: e.value });
        continue;
      }
      if (spec.kind === "date") {
        const w = parseWhen(v);
        if (!w.ok) return { ok: false, error: `${spec.label}解析不了，用 YYYY-MM-DD` };
        changes.push({ field: f, value: w.at });
        continue;
      }
      changes.push({ field: f, value: str(v, 500) });
    }
    if (!changes.length) return { ok: false, error: "changes 是空的，没有要改的字段" };
    return { ok: true, proposal: { ...base, kind, changes } };
  }

  if (kind === "add_opportunity") {
    const stage = pickEnum(args.stage, OPP_STAGES, OPP_STAGES[0]);
    if (!stage.ok) return { ok: false, error: `stage 必须是：${OPP_STAGES.join("/")}` };
    const when = parseWhen(args.expectedDealAt);
    if (!when.ok) return { ok: false, error: "expectedDealAt 解析不了，用 YYYY-MM-DD" };
    const amount = 收金额(args.amount);
    if (amount === null) return { ok: false, error: "amount 要是个非负数字" };
    const p = 收概率(args.probability);
    if (p === null) return { ok: false, error: "probability 要在 0~100 之间" };
    return {
      ok: true,
      proposal: { ...base, kind, name: str(args.name, 60), amount, stage: stage.value, probability: p ?? STAGE_PROBABILITY[stage.value] ?? 10, expectedDealAt: when.at, remark: str(args.remark, 500) },
    };
  }

  /**
   * 改渠道。单独一种卡，因为**渠道负责人不是客户身上的字段**——
   * 它挂在 Channel 上，整条推荐链继承（见 CustomerForm 的注释：
   * 「渠道归属与渠道负责人由系统按推荐链自动计算」）。
   * 模型原来找不到这个字段时会往「来源渠道」「推荐人」上硬套，
   * 把一个销售的名字填进渠道栏。给它一条正确的路，比让它猜强。
   */
  if (kind === "update_channel") {
    const 渠道 = str(args.channelName, 60);
    if (!渠道) return { ok: false, error: "channelName 必填：要改哪个渠道" };
    return {
      ok: true,
      proposal: {
        ...base,
        kind,
        channelName: 渠道,
        ownerName: str(args.ownerName, 20),
        phone: str(args.phone, 30),
        remark: str(args.remark, 500),
      },
    };
  }

  if (kind === "add_contract") {
    const when = parseWhen(args.signedAt);
    if (!when.ok) return { ok: false, error: "signedAt 解析不了，用 YYYY-MM-DD" };
    const amount = 收金额(args.amount);
    if (amount === null) return { ok: false, error: "amount 要是个非负数字" };
    return { ok: true, proposal: { ...base, kind, amount, signedAt: when.at, remark: str(args.remark, 500) } };
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
  if (p.kind === "update_customer") {
    for (const c of p.changes) {
      const spec = 可改字段[c.field];
      // 姓名和负责人清空会让记录立不住；其余字段留空是合法的"清掉这一项"
      if ((c.field === "name" || c.field === "salesOwnerName") && !c.value.trim()) miss.push(spec.label);
      if (spec.kind === "enum" && !c.value) miss.push(spec.label);
    }
  }
  if (p.kind === "add_opportunity") {
    if (!p.name.trim()) miss.push("商机名称");
    if (!p.amount) miss.push("金额");
  }
  if (p.kind === "add_contract") {
    if (!p.amount) miss.push("签约金额");
    if (!p.signedAt) miss.push("签约日期");
  }
  if (p.kind === "update_channel" && !p.ownerName.trim() && !p.phone.trim() && !p.remark.trim()) miss.push("要改什么");
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
  if (p.kind === "update_customer") {
    const 项 = p.changes.map((c) => 可改字段[c.field].label);
    return `改${customerNoun}「${p.customerName}」的${项.join("、")}`;
  }
  if (p.kind === "add_opportunity") return `给「${p.customerName}」新建商机${p.name ? `「${p.name}」` : ""}`;
  if (p.kind === "add_contract") return `给「${p.customerName}」记一笔签约${p.amount ? ` ¥${p.amount}` : ""}`;
  if (p.kind === "update_channel") {
    const 项 = [p.ownerName && "负责人", p.phone && "电话", p.remark && "备注"].filter(Boolean);
    return `改渠道「${p.channelName}」的${项.join("、") || "信息"}`;
  }
  return `新建一条线索${p.name ? `「${p.name}」` : ""}`;
}

/** 落库后写进操作日志的那句话 */
export function summarizeApplied(p: Proposal, customerNoun: string): string {
  return `确认 AI 建议：${describeProposal(p, customerNoun)}`;
}
