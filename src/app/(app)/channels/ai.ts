"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { consumeAiQuota } from "@/lib/ai-quota";
import { recordAiUse } from "@/lib/ai-usage";
import { chatJSON } from "@/lib/llm";
import { dayjs } from "@/lib/utils";
import { FOLLOW_TYPE_MAP } from "@/lib/constants";
import { getBusiness } from "@/lib/business";

/**
 * 转介绍雷达的「起草邀请」：给已签约学员写一条请求转介绍的微信草稿。
 * AI 只起草——由销售自己复制发出，系统不做任何触达。
 */
export async function draftInvite(input: {
  customerId: string;
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
      remark: true,
      referrerCustomer: { select: { name: true } },
      channel: { select: { name: true } },
      contracts: { select: { amount: true }, orderBy: { signedAt: "desc" }, take: 1 },
      followUps: {
        orderBy: { occurredAt: "desc" },
        take: 6,
        select: { type: true, content: true, occurredAt: true },
      },
    },
  });
  if (!customer) return { ok: false, error: `${b.customer}不存在` };

  const origin = customer.referrerCustomer?.name ?? customer.channel?.name ?? null;
  const timeline = customer.followUps.length
    ? customer.followUps
        .map((f) => `- ${dayjs(f.occurredAt).format("MM-DD")} ${FOLLOW_TYPE_MAP[f.type]?.label ?? f.type}：${f.content.slice(0, 200)}`)
        .join("\n")
    : "（无跟进记录）";

  const prompt = `你替销售起草一条发给已签约${b.customer}的微信消息，礼貌地请对方帮忙介绍身边有同样需要的人。

${b.customer}：${customer.name}${customer.grade ? `（${customer.grade}）` : ""}，已签约
${origin ? `TA 自己当初也是「${origin}」介绍来的，可以自然地借这一点开口` : "TA 是自己找来的，没有推荐人"}
备注：${(customer.remark || "无").slice(0, 100)}
最近的跟进记录（新→旧）：
${timeline}

要求：120 字以内；先真诚关心近况（有记录就从具体话题切入），再顺势提一句"身边如果有人需要，欢迎介绍"；语气自然不市侩，不承诺任何返利或好处；禁止编造没聊过的内容。
输出严格 JSON：{"message": "..."}`;

  try {
    const raw = (await chatJSON(prompt)) as { message?: unknown };
    const message = typeof raw.message === "string" ? raw.message.trim().slice(0, 300) : "";
    if (!message) return { ok: false, error: "AI 未能生成话术，请重试" };
    await recordAiUse(user, "invite", `AI 起草转介绍邀请（${b.customer}「${customer.name}」）`, input.customerId);
    return { ok: true, message };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "生成失败，请稍后重试" };
  }
}
