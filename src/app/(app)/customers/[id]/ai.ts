"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { consumeAiQuota } from "@/lib/ai-quota";
import { recordAiUse } from "@/lib/ai-usage";
import { chatJSON } from "@/lib/llm";
import { sanitizeFollowUpDraft, sanitizeBrief, type FollowUpDraft, type CustomerBrief } from "@/lib/ai-draft";
import { dayjs } from "@/lib/utils";
import { FOLLOW_TYPE_MAP } from "@/lib/constants";
import { getBusiness } from "@/lib/business";
import { statusLabel } from "@/lib/business-config";

/**
 * AI 只起草、不落库：这两个 action 都不写业务表。
 * 速记解析的结果回到表单由人核对后走原有的 saveFollowUp / saveTask / savePlan，
 * 保证 AI 辅助的写入和手工写入走完全相同的校验与留痕路径。
 */

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function nowLine(): string {
  const n = dayjs();
  return `${n.format("YYYY-MM-DD HH:mm")}（${WEEKDAYS[n.day()]}）`;
}

/* ---------------- 跟进速记 ---------------- */

export async function parseFollowUpDraft(input: {
  customerId: string;
  text: string;
}): Promise<{ ok: true; draft: FollowUpDraft } | { ok: false; error: string }> {
  const user = await requireUser();
  const b = await getBusiness();
  const wait = consumeAiQuota(user.id);
  if (wait !== null) return { ok: false, error: `AI 调用太频繁，请 ${wait} 秒后再试` };

  const text = input.text.trim();
  if (text.length < 5) return { ok: false, error: "内容太短，AI 没有可整理的信息" };
  if (text.length > 5000) return { ok: false, error: "内容过长（超过 5000 字），请分段录入" };

  const customer = await prisma.customer.findUnique({
    where: { id: input.customerId },
    select: {
      name: true,
      school: true,
      grade: true,
      contacts: { select: { id: true, name: true, position: true } },
      opportunities: { where: { status: "OPEN" }, select: { id: true, name: true } },
    },
  });
  if (!customer) return { ok: false, error: `${b.customer}不存在` };

  const contactLines = customer.contacts.length
    ? customer.contacts.map((c) => `  - ${c.id}：${c.name}${c.position ? `（${c.position}）` : ""}`).join("\n")
    : "  （无）";
  const oppLines = customer.opportunities.length
    ? customer.opportunities.map((o) => `  - ${o.id}：${o.name}`).join("\n")
    : "  （无）";

  const prompt = `现在时间：${nowLine()}
${b.customer}：${customer.name}${[customer.school, customer.grade].filter(Boolean).length ? `（${[customer.school, customer.grade].filter(Boolean).join(" · ")}）` : ""}
该${b.customer}的联系人（contactId：姓名）：
${contactLines}
该${b.customer}进行中的商机（opportunityId：名称）：
${oppLines}

【销售的原话】
"""
${text}
"""

原话有两种可能：销售自己的口头转述，或直接粘贴的微信聊天记录（含双方多条消息、
可能带昵称和时间戳）。是聊天记录时：分清哪些话是销售说的、哪些是${b.customer}一方说的，
提炼整段对话的要点作为 content，type 用 SMS，occurredAt 取对话中最后一条的时间。

请把原话整理成 CRM 跟进记录，输出严格 JSON，结构如下：
{
  "followUp": {
    "type": "PHONE",
    "title": "一句话概括（可为空字符串）",
    "content": "整理后的沟通要点",
    "status": "已完成",
    "durationMinutes": 20,
    "occurredAt": "YYYY-MM-DD HH:mm",
    "contactId": null,
    "opportunityId": null
  },
  "tasks": [{ "title": "销售自己接下来要做的事", "dueAt": "YYYY-MM-DD HH:mm" }],
  "plan": { "subject": "下次沟通主题", "plannedAt": "YYYY-MM-DD HH:mm", "method": "电话沟通" },
  "followStatusSuggestion": null,
  "decisionStatusSuggestion": null
}

字段规则：
- type 取值：PHONE 电话 / MEETING 线上会议 / VISIT 上门拜访 / EMAIL 邮件 / SMS 短信或微信等文字消息 / TASK 跟进任务 / REMIND 跟进提醒 / OTHER 其他
- content：以销售第一人称整理沟通要点，只保留原话里的事实，禁止编造与发挥
- durationMinutes：原话明确提到时长才填（分钟数），否则 null
- 时间一律写成「YYYY-MM-DD HH:mm」；相对时间基于现在时间换算（"下周三晚上"→下周三 19:00；上午按 10:00、下午按 15:00、晚上按 19:00 估）
- occurredAt 是这次沟通发生的时间，原话没提就 null
- tasks：销售自己要做的事，最多 5 条；没有就 []
- plan：下一次与${b.customer}的沟通安排，没有就 null；method 取值：电话沟通/线上会议/上门拜访/邮件沟通/微信沟通
- followStatusSuggestion：仅当原话显示销售推进有明显变化时给，取值：待跟进/跟进中/已加微信/已试听/意向较高/暂缓跟进/已签约/已流失，否则 null
- decisionStatusSuggestion：仅当${b.customer}决策阶段有明显变化时给，取值：了解中/对比中/与家人商议/等待预算/已决定报名/暂不考虑，否则 null
- contactId / opportunityId：只在原话能明确对应到上面列表中的某一项时填其 id，否则 null`;

  try {
    const raw = await chatJSON(prompt);
    const draft = sanitizeFollowUpDraft(raw, {
      contactIds: customer.contacts.map((c) => c.id),
      opportunityIds: customer.opportunities.map((o) => o.id),
    });
    // 解析本身不写业务数据，但按「AI 动了什么都可追溯」的口径留一条使用痕迹
    await recordAiUse(user, "parse", `AI 解析跟进速记（${b.customer}「${customer.name}」，识别为${FOLLOW_TYPE_MAP[draft.followUp.type]?.label ?? draft.followUp.type}）`, input.customerId);
    return { ok: true, draft };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "AI 解析失败，请稍后重试" };
  }
}

/* ---------------- 临战简报 ---------------- */

export async function generateBrief(input: {
  customerId: string;
}): Promise<{ ok: true; brief: CustomerBrief } | { ok: false; error: string }> {
  const user = await requireUser();
  const b = await getBusiness();
  const wait = consumeAiQuota(user.id);
  if (wait !== null) return { ok: false, error: `AI 调用太频繁，请 ${wait} 秒后再试` };

  const customer = await prisma.customer.findUnique({
    where: { id: input.customerId },
    include: {
      salesOwner: { select: { name: true } },
      referrerCustomer: { select: { name: true } },
      channel: { select: { name: true } },
      contracts: { select: { amount: true, signedAt: true } },
      opportunities: {
        select: { name: true, amount: true, stage: true, status: true, expectedDealAt: true },
        orderBy: { createdAt: "desc" },
      },
      tasks: { where: { done: false }, select: { title: true, dueAt: true }, orderBy: { dueAt: "asc" } },
      plans: { where: { done: false }, select: { subject: true, plannedAt: true, method: true }, take: 1 },
      followUps: {
        orderBy: { occurredAt: "desc" },
        take: 30,
        select: { type: true, title: true, content: true, occurredAt: true, duration: true, owner: { select: { name: true } } },
      },
    },
  });
  if (!customer) return { ok: false, error: `${b.customer}不存在` };
  if (customer.followUps.length === 0) {
    return { ok: false, error: `该${b.customer}还没有任何跟进记录，暂时没有可提炼的内容` };
  }

  // 时间线倒序给太多没意义，取最近 30 条、每条内容截断，控制 prompt 体量。
  // 不携带电话号码等联系方式——简报用不上，最小上下文原则。
  const timeline = customer.followUps
    .map((f) => {
      const label = FOLLOW_TYPE_MAP[f.type]?.label ?? f.type;
      const dur = f.duration ? `，${Math.round(f.duration / 60)}分钟` : "";
      const title = f.title ? `【${f.title}】` : "";
      return `- ${dayjs(f.occurredAt).format("MM-DD")} ${label}（${f.owner.name}${dur}）${title}${f.content.slice(0, 300)}`;
    })
    .join("\n");

  const oppLines = customer.opportunities.length
    ? customer.opportunities
        .map(
          (o) =>
            `- ${o.name}：¥${Math.round(o.amount)}，${o.status === "WON" ? "已赢单" : o.status === "LOST" ? "已丢单" : `进行中（${o.stage}）`}`,
        )
        .join("\n")
    : "（无）";
  const taskLines = customer.tasks.length
    ? customer.tasks.map((t) => `- ${t.title}${t.dueAt ? `（截止 ${dayjs(t.dueAt).format("MM-DD HH:mm")}）` : ""}`).join("\n")
    : "（无）";
  const plan = customer.plans[0];
  const signedTotal = customer.contracts.reduce((s, c) => s + c.amount, 0);

  const prompt = `现在时间：${nowLine()}
你要为销售「${customer.salesOwner.name}」生成联系${b.customer}前的一页简报。

【${b.customer}档案】
姓名：${customer.name}
${b.fields.school}/${b.fields.grade}/${b.fields.major}：${[customer.school, customer.grade, customer.major].filter(Boolean).join(" / ") || "未填"}
跟进状态：${statusLabel(b, customer.followStatus)}；决策状态：${statusLabel(b, customer.decisionStatus)}
推荐来源：${customer.referrerCustomer?.name ?? customer.channel?.name ?? "无记录"}
预计签约：${customer.expectedSignAt ? dayjs(customer.expectedSignAt).format("YYYY-MM-DD") : "未定"}；已签约金额：${signedTotal > 0 ? `¥${signedTotal}` : "未签约"}
备注：${customer.remark || "（无）"}

【商机】
${oppLines}

【未完成的待办】
${taskLines}

【下次跟进计划】
${plan ? `${dayjs(plan.plannedAt).format("YYYY-MM-DD HH:mm")} ${plan.method}：${plan.subject}` : "（未安排）"}

【跟进时间线（新→旧，最近 ${customer.followUps.length} 条）】
${timeline}

请输出严格 JSON：
{
  "story": "这个${b.customer}的完整故事线：怎么来的、聊过什么、态度如何演变，120 字以内",
  "current": "现在卡在哪、上次聊到哪，60 字以内",
  "talkingPoints": ["这次建议谈的要点，3~5 条，每条 40 字以内，具体可执行"],
  "risks": ["风险信号，0~3 条，每条 40 字以内；没有就给空数组"]
}

规则：只基于上面提供的记录提炼，禁止编造；用给销售看的口语化中文；结论要具体（引用${b.customer}真实的顾虑与原话要点），不要空话套话。`;

  try {
    const raw = await chatJSON(prompt);
    await recordAiUse(user, "brief", `AI 生成简报（${b.customer}「${customer.name}」）`, input.customerId);
    return { ok: true, brief: sanitizeBrief(raw) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "简报生成失败，请稍后重试" };
  }
}
