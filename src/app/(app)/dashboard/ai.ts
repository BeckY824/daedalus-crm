"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { consumeAiQuota } from "@/lib/ai-quota";
import { recordAudit } from "@/lib/audit";
import { chatJSON } from "@/lib/llm";
import { dayjs } from "@/lib/utils";
import { FOLLOW_TYPE_MAP } from "@/lib/constants";

/**
 * 盯盘清单的「起草跟进」：给一条唤醒话术草稿。
 * AI 只起草——消息由销售自己复制到微信发出，系统不做任何触达。
 */
export async function draftWakeup(input: {
  customerId: string;
  reason: string;
}): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const user = await requireUser();
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
        select: { type: true, content: true, occurredAt: true },
      },
    },
  });
  if (!customer) return { ok: false, error: "学员不存在" };

  const timeline = customer.followUps.length
    ? customer.followUps
        .map((f) => `- ${dayjs(f.occurredAt).format("MM-DD")} ${FOLLOW_TYPE_MAP[f.type]?.label ?? f.type}：${f.content.slice(0, 200)}`)
        .join("\n")
    : "（从未跟进过）";

  const prompt = `你替教培销售起草一条发给学员/家长的微信消息，用来重新接上中断的沟通。

学员：${customer.name}${customer.grade ? `（${customer.grade}）` : ""}，跟进状态「${customer.followStatus}」，决策状态「${customer.decisionStatus}」
唤醒原因：${input.reason.slice(0, 100)}
备注：${(customer.remark || "无").slice(0, 100)}
最近的跟进记录（新→旧）：
${timeline}

要求：120 字以内；自然、像人写的，不像群发；从上次聊到的具体话题切入（有记录就必须用）；给一个轻量的由头（如约试听、发资料、问近况），不硬推销、不催单；禁止编造没聊过的内容。
输出严格 JSON：{"message": "..."}`;

  try {
    const raw = (await chatJSON(prompt)) as { message?: unknown };
    const message = typeof raw.message === "string" ? raw.message.trim().slice(0, 300) : "";
    if (!message) return { ok: false, error: "AI 未能生成话术，请重试" };
    await recordAudit({
      user,
      action: "ai_draft",
      entity: "Customer",
      entityId: input.customerId,
      summary: `AI 起草唤醒话术（学员「${customer.name}」：${input.reason.slice(0, 50)}）`,
    });
    return { ok: true, message };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "生成失败，请稍后重试" };
  }
}
