"use server";

import { requireUser } from "@/lib/auth";
import { consumeAiQuota } from "@/lib/ai-quota";
import { chatJSON } from "@/lib/llm";
import { dayjs } from "@/lib/utils";
import { METRICS, GROUP_BYS, VALID_GROUPS, sanitizeQuerySpec, type ResultRow } from "@/lib/report-query";
import { runQuery } from "@/lib/report-run";
import { getBusiness } from "@/lib/business";
import { recordAiUse } from "@/lib/ai-usage";
import { stepStart, stepDone, type Emit } from "@/lib/ai-steps";

export type AskResult = {
  answer: string;
  metricLabel: string;
  unit: string;
  groupByLabel: string | null;
  range: string;
  rows: ResultRow[];
};

/** 问数据：自然语言 → 受限 QuerySpec → Prisma 取数 → 一句话结论。只读，不写库 */
export async function askData(question: string, emit?: Emit): Promise<{ ok: true; result: AskResult } | { ok: false; error: string }> {
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
- 问"谁最多/哪个最高"这类比较，或问题里带"各个/每个/按…/分别"这类分组词（"各跟进状态各有多少""每个销售签了多少"）时，必须给对应的 groupBy；问单个总数时 groupBy 给 null
- **只查已经发生的事**。问未来（"明天能签几单""下个月预计多少"）属于预测，不是查询，
  输出 {"metric": "unsupported"}——把它当成查未来某天的记录会答出"0 笔"，读的人
  会误以为系统在预测，比直接说不支持更糟
- 问不在指标范围内的事，输出 {"metric": "unsupported"}

问题：${q}`;

  try {
    stepStart(emit, "spec", "翻译成查询规格");
    const spec = sanitizeQuerySpec(await chatJSON(specPrompt));
    const meta = { ...METRICS[spec.metric], label: term(METRICS[spec.metric].label) };
    const range =
      spec.from || spec.to ? `${spec.from ?? "最早"} ~ ${spec.to ?? "今天"}` : "不限时间";
    stepDone(emit, "spec", "翻译成查询规格", `${meta.label}${spec.groupBy ? ` · ${GROUP_BYS[spec.groupBy]}` : ""} · ${range}`);
    stepStart(emit, "query", "查库");
    const rows = await runQuery(spec, b);
    stepDone(emit, "query", "查库", `${rows.length} 行`);
    stepStart(emit, "phrase", "写结论");

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

    stepDone(emit, "phrase", "写结论");
    await recordAiUse(user, "ask", `AI 问数据：「${q.slice(0, 60)}」`);

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
