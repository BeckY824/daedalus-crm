"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { consumeAiQuota } from "@/lib/ai-quota";
import { recordAiUse } from "@/lib/ai-usage";
import { chatJSON } from "@/lib/llm";
import { getBusiness } from "@/lib/business";
import { statusLabel } from "@/lib/business-config";
import { formatTimeline } from "@/lib/ai-context";

/**
 * 盯盘清单的「起草跟进」：给一条唤醒话术草稿。
 * AI 只起草——消息由销售自己复制到微信发出，系统不做任何触达。
 */
export async function draftWakeup(input: {
  customerId: string;
  reason: string;
}): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const b = await getBusiness();
  const wait = consumeAiQuota(user.id);
  if (wait !== null) return { ok: false, error: `AI 调用太频繁，请 ${wait} 秒后再试` };

  const customer = await prisma.customer.findUnique({
    where: { id: input.customerId },
    select: {
      name: true,
      grade: true,
      followStatus: true,
      decisionStatus: true,
      remark: true,
      followUps: {
        orderBy: { occurredAt: "desc" },
        take: 8,
        select: { type: true, content: true, occurredAt: true, source: { select: { text: true } } },
      },
    },
  });
  if (!customer) return { ok: false, error: `${b.customer}不存在` };

  // 有原文就带上：唤醒话术要"从上次聊到的具体话题切入"，原话比整理后的要点准得多
  const timeline = customer.followUps.length
    ? formatTimeline(customer.followUps, { eachMax: 600, budget: 2000 })
    : "（从未跟进过）";

  const prompt = `你替销售「${user.name}」起草一条发给${b.customer}的微信消息，用来重新接上中断的沟通。落款或自称一律用「${user.name}」，不要编别的名字或机构名。

${b.customer}：${customer.name}${customer.grade ? `（${customer.grade}）` : ""}，跟进状态「${statusLabel(b, customer.followStatus)}」，决策状态「${statusLabel(b, customer.decisionStatus)}」
唤醒原因：${input.reason.slice(0, 100)}
备注：${(customer.remark || "无").slice(0, 100)}
最近的跟进记录（新→旧；带「原文」的是当时的聊天记录原话）：
${timeline}

要求：120 字以内；自然、像人写的，不像群发；从上次聊到的具体话题切入（有记录就必须用）；给一个轻量的由头（发资料、问近况、约个时间），不硬推销、不催单；禁止编造没聊过的内容。
输出严格 JSON：{"message": "..."}`;

  try {
    const raw = (await chatJSON(prompt)) as { message?: unknown };
    const message = typeof raw.message === "string" ? raw.message.trim().slice(0, 300) : "";
    if (!message) return { ok: false, error: "AI 未能生成话术，请重试" };
    await recordAiUse(user, "wakeup", `AI 起草唤醒话术（${b.customer}「${customer.name}」：${input.reason.slice(0, 50)}）`, input.customerId);
    return { ok: true, message };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "生成失败，请稍后重试" };
  }
}

/* ---------------- 盯盘解读 ---------------- */

/**
 * 给盯盘清单里的每一条补一句"为什么现在该联系"。
 * 规则只知道"18 天没跟"，不知道上次聊到哪——这句话得看原文才写得出来。
 * 一次调用覆盖整张清单（最多 8 条），由销售点按钮触发；不在页面加载时自动跑：
 * 每刷一次首页打 8 次模型既慢又费，盯盘本身不依赖它。不落库。
 */
export async function explainWatchlist(input: {
  items: { customerId: string; reason: string }[];
}): Promise<{ ok: true; notes: Record<string, string> } | { ok: false; error: string }> {
  const user = await requireUser();
  const b = await getBusiness();
  const wait = consumeAiQuota(user.id);
  if (wait !== null) return { ok: false, error: `AI 调用太频繁，请 ${wait} 秒后再试` };

  const ids = [...new Set(input.items.map((i) => i.customerId))].slice(0, 8);
  if (ids.length === 0) return { ok: false, error: "清单为空" };

  const customers = await prisma.customer.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      name: true,
      followStatus: true,
      decisionStatus: true,
      followUps: {
        orderBy: { occurredAt: "desc" },
        take: 3,
        select: { type: true, content: true, occurredAt: true, source: { select: { text: true } } },
      },
    },
  });
  if (customers.length === 0) return { ok: false, error: `${b.customer}不存在` };

  const reasonOf = new Map(input.items.map((i) => [i.customerId, i.reason.slice(0, 100)]));
  const blocks = customers
    .map(
      (c) => `### ${c.id}
${b.customer}：${c.name}，跟进状态「${statusLabel(b, c.followStatus)}」，决策状态「${statusLabel(b, c.decisionStatus)}」
系统提醒：${reasonOf.get(c.id) ?? ""}
最近跟进（新→旧）：
${c.followUps.length ? formatTimeline(c.followUps, { eachMax: 400, budget: 800 }) : "（从未跟进过）"}`,
    )
    .join("\n\n");

  const prompt = `下面是盯盘清单里几位正在被遗忘的${b.customer}。系统只知道"多少天没跟"，你要结合每位的跟进记录，
替销售各写一句话（30 字以内）：现在联系该从哪里接上、为什么值得现在联系。有原文就引用${b.customer}上次的具体顾虑或话题。
没有任何跟进记录的，就直说"没有记录，先做首次接触"。禁止编造没聊过的内容。

${blocks}

输出严格 JSON，key 是上面 ### 后面的 id：{"<id>": "一句话", ...}`;

  try {
    const raw = (await chatJSON(prompt)) as Record<string, unknown>;
    const notes: Record<string, string> = {};
    for (const c of customers) {
      const v = raw?.[c.id];
      if (typeof v === "string" && v.trim()) notes[c.id] = v.trim().slice(0, 120);
    }
    if (Object.keys(notes).length === 0) return { ok: false, error: "AI 未能给出解读，请重试" };
    await recordAiUse(user, "explain", `AI 解读盯盘清单（${customers.length} 位${b.customer}）`);
    return { ok: true, notes };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "生成失败，请稍后重试" };
  }
}
