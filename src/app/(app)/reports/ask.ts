"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { consumeAiQuota } from "@/lib/ai-quota";
import { chatJSON } from "@/lib/llm";
import { dayjs } from "@/lib/utils";
import { FOLLOW_TYPE_MAP } from "@/lib/constants";
import {
  METRICS,
  GROUP_BYS,
  VALID_GROUPS,
  sanitizeQuerySpec,
  sumRows,
  rateRows,
  bucketMonth,
  type QuerySpec,
  type ResultRow,
  type GroupBy,
} from "@/lib/report-query";
import { getBusiness } from "@/lib/business";

export type AskResult = {
  answer: string;
  metricLabel: string;
  unit: string;
  groupByLabel: string | null;
  range: string;
  rows: ResultRow[];
};

/** 问数据：自然语言 → 受限 QuerySpec → Prisma 取数 → 一句话结论。只读，不写库 */
export async function askData(question: string): Promise<{ ok: true; result: AskResult } | { ok: false; error: string }> {
  const user = await requireUser();
  const b = await getBusiness();
  const term = (s: string) => s.replace(/学员/g, b.customer);
  const wait = consumeAiQuota(user.id);
  if (wait !== null) return { ok: false, error: `AI 调用太频繁，请 ${wait} 秒后再试` };

  const q = question.trim();
  if (q.length < 4) return { ok: false, error: "问题太短，说清楚想看什么数" };
  if (q.length > 300) return { ok: false, error: "问题太长，请精简到一句话" };

  const combos = (Object.keys(METRICS) as (keyof typeof METRICS)[])
    .map((m) => `  - ${m}（${term(METRICS[m].label)}）可用 groupBy：${VALID_GROUPS[m].join(" / ") || "无"}`)
    .join("\n");

  const specPrompt = `今天是 ${dayjs().format("YYYY-MM-DD")}（${"日一二三四五六"[dayjs().day()]}）。
把下面的业务问题翻译成查询规格，输出严格 JSON：{"metric": "...", "groupBy": "..." 或 null, "from": "YYYY-MM-DD" 或 null, "to": "YYYY-MM-DD" 或 null}

可用指标与各自允许的拆分维度：
${combos}
维度含义：month 按月走势 / sales 按销售负责人 / channel 按来源渠道 / source 按线索来源 / grade 按年级 / followStatus 按跟进状态 / decisionStatus 按决策状态 / type 按跟进类型

规则：
- 相对时间基于今天换算成具体日期，from/to 都含当天；问题没限定时间就都给 null
- 问"谁最多/哪个最高"这类比较时必须给对应的 groupBy；问单个总数时 groupBy 给 null
- **只查已经发生的事**。问未来（"明天能签几单""下个月预计多少"）属于预测，不是查询，
  输出 {"metric": "unsupported"}——把它当成查未来某天的记录会答出"0 笔"，读的人
  会误以为系统在预测，比直接说不支持更糟
- 问不在指标范围内的事，输出 {"metric": "unsupported"}

问题：${q}`;

  try {
    const spec = sanitizeQuerySpec(await chatJSON(specPrompt));
    const rows = await runQuery(spec);
    const meta = { ...METRICS[spec.metric], label: term(METRICS[spec.metric].label) };
    const range =
      spec.from || spec.to ? `${spec.from ?? "最早"} ~ ${spec.to ?? "今天"}` : "不限时间";

    // 结论由第二次调用基于真实数字生成；AI 挂了也不空手——用合计兜底
    const total = Math.round(rows.reduce((s, r) => s + r.value, 0) * 10) / 10;
    let answer = `${meta.label}${spec.groupBy ? `（${GROUP_BYS[spec.groupBy]}，前 ${rows.length} 项）` : ""}合计 ${total}${meta.unit === "%" ? "" : meta.unit}`;
    try {
      const phrased = (await chatJSON(
        `问题：${q}\n查询：${meta.label}${spec.groupBy ? ` ${GROUP_BYS[spec.groupBy]}` : ""}，时间 ${range}，单位 ${meta.unit}\n结果：${JSON.stringify(rows)}\n只基于以上数字，用一句话（60 字以内）直接回答问题，禁止编造。输出 JSON：{"answer": "..."}`,
      )) as { answer?: unknown };
      if (typeof phrased.answer === "string" && phrased.answer.trim()) {
        answer = phrased.answer.trim().slice(0, 200);
      }
    } catch {
      /* 用兜底句 */
    }

    return {
      ok: true,
      result: {
        answer,
        metricLabel: meta.label,
        unit: meta.unit,
        groupByLabel: spec.groupBy ? GROUP_BYS[spec.groupBy] : null,
        range,
        rows,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? term(e.message) : "查询失败，请稍后重试" };
  }
}

/* ---------------- 取数 ---------------- */

function dateWhere(field: string, spec: QuerySpec) {
  const cond: Record<string, Date> = {};
  if (spec.from) cond.gte = dayjs(spec.from).startOf("day").toDate();
  if (spec.to) cond.lte = dayjs(spec.to).endOf("day").toDate();
  return Object.keys(cond).length ? { [field]: cond } : {};
}

/** 归组 key/label。key 用 id（姓名可重复，按名归组会把两个人加进同一行） */
function keyOf(groupBy: GroupBy | null, when: Date, dims: Record<string, { id: string; label: string } | string | null>) {
  if (groupBy === "month") {
    const m = bucketMonth(when);
    return { key: m, label: m };
  }
  const d = groupBy ? dims[groupBy] : null;
  if (groupBy && (d == null || d === "")) return { key: "__none__", label: "未填/未分配" };
  if (typeof d === "string") return { key: d, label: d };
  if (d) return { key: d.id, label: d.label };
  return { key: "__all__", label: "全部" };
}

async function runQuery(spec: QuerySpec): Promise<ResultRow[]> {
  const byMonth = spec.groupBy === "month";

  if (spec.metric === "leads_count" || spec.metric === "lead_conversion") {
    const leads = await prisma.lead.findMany({
      where: dateWhere("createdAt", spec),
      select: { createdAt: true, source: true, status: true, owner: { select: { id: true, name: true } } },
    });
    const shaped = leads.map((l) => ({
      ...keyOf(spec.groupBy, l.createdAt, {
        source: l.source,
        sales: l.owner ? { id: l.owner.id, label: l.owner.name } : null,
      }),
      converted: l.status === "已转化" ? 1 : 0,
    }));
    if (spec.metric === "leads_count") {
      return sumRows(shaped.map((s) => ({ key: s.key, label: s.label, value: 1 })), { byMonth });
    }
    return rateRows(shaped.map((s) => ({ key: s.key, label: s.label, created: 1, converted: s.converted })), { byMonth });
  }

  if (spec.metric === "customers_count") {
    const customers = await prisma.customer.findMany({
      where: dateWhere("createdAt", spec),
      select: {
        createdAt: true,
        grade: true,
        followStatus: true,
        decisionStatus: true,
        salesOwner: { select: { id: true, name: true } },
        channel: { select: { id: true, name: true } },
      },
    });
    return sumRows(
      customers.map((c) => ({
        ...keyOf(spec.groupBy, c.createdAt, {
          sales: { id: c.salesOwner.id, label: c.salesOwner.name },
          channel: c.channel ? { id: c.channel.id, label: c.channel.name } : null,
          grade: c.grade,
          followStatus: c.followStatus,
          decisionStatus: c.decisionStatus,
        }),
        value: 1,
      })),
      { byMonth },
    );
  }

  if (spec.metric === "contract_amount" || spec.metric === "contract_count") {
    const contracts = await prisma.contract.findMany({
      where: dateWhere("signedAt", spec),
      select: {
        amount: true,
        signedAt: true,
        customer: {
          select: {
            salesOwner: { select: { id: true, name: true } },
            channel: { select: { id: true, name: true } },
          },
        },
      },
    });
    return sumRows(
      contracts.map((c) => ({
        ...keyOf(spec.groupBy, c.signedAt, {
          sales: { id: c.customer.salesOwner.id, label: c.customer.salesOwner.name },
          channel: c.customer.channel ? { id: c.customer.channel.id, label: c.customer.channel.name } : null,
        }),
        value: spec.metric === "contract_amount" ? c.amount : 1,
      })),
      { byMonth },
    );
  }

  // followups_count
  const followUps = await prisma.followUp.findMany({
    where: dateWhere("occurredAt", spec),
    select: { occurredAt: true, type: true, owner: { select: { id: true, name: true } } },
  });
  return sumRows(
    followUps.map((f) => ({
      ...keyOf(spec.groupBy, f.occurredAt, {
        sales: { id: f.owner.id, label: f.owner.name },
        type: FOLLOW_TYPE_MAP[f.type]?.label ?? f.type,
      }),
      value: 1,
    })),
    { byMonth },
  );
}
