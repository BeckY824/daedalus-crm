"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { askData, type AskResult } from "../reports/ask";
import { generateBrief } from "../customers/[id]/ai";
import type { CustomerBrief } from "@/lib/ai-draft";

export type HomeAnswer =
  | { kind: "data"; result: AskResult }
  | { kind: "customer"; customerId: string; customerName: string; brief: CustomerBrief };

/**
 * 首页提问：一个输入框，两种去向。
 *
 * 问题里点到某位学员的名字 → 出这位学员的临战简报（围绕问题回答）；
 * 否则当成业务数字问题 → 走报表页的「问数据」。
 * 两条路都是现成的 Server Action，这里只做分流，不新增任何 AI 能力，也不写库。
 */
export async function askHome(question: string): Promise<{ ok: true; answer: HomeAnswer } | { ok: false; error: string }> {
  await requireUser();
  const b = await getBusiness();
  const q = question.trim();
  if (q.length < 2) return { ok: false, error: "问题太短" };
  if (q.length > 300) return { ok: false, error: "问题太长，请精简到一句话" };

  // 姓名匹配：取所有学员名（几百条，毫秒级），找问题里包含的最长姓名；
  // 单字名太容易误命中（"王"、"李"），不参与匹配
  const customers = await prisma.customer.findMany({ select: { id: true, name: true } });
  const hits = customers.filter((c) => c.name.length >= 2 && q.includes(c.name)).sort((a, c) => c.name.length - a.name.length);
  if (hits.length > 0) {
    const name = hits[0].name;
    const same = hits.filter((h) => h.name === name);
    if (same.length > 1) {
      return { ok: false, error: `有 ${same.length} 位叫「${name}」的${b.customer}，请到${b.customer}详情页里用临战简报` };
    }
    const res = await generateBrief({ customerId: hits[0].id, question: q });
    if (!res.ok) return res;
    return { ok: true, answer: { kind: "customer", customerId: hits[0].id, customerName: name, brief: res.brief } };
  }

  const res = await askData(q);
  if (!res.ok) return res;
  return { ok: true, answer: { kind: "data", result: res.result } };
}

/**
 * 两个快捷动作。学员由系统挑：
 *   准备下次跟进 → 我最近一条未完成的跟进计划对应的学员
 *   回顾上次沟通 → 我最近一次跟进的学员
 * 不让人先选学员再点——那和去详情页点简报没区别，首页入口的意义就在少这一步。
 */
export async function quickBrief(intent: "prep" | "recap"): Promise<{ ok: true; answer: HomeAnswer } | { ok: false; error: string }> {
  const user = await requireUser();
  const b = await getBusiness();

  let customer: { id: string; name: string } | null = null;
  if (intent === "prep") {
    // 按计划时间从早到晚（逾期的排最前）。简报要有跟进记录才提炼得出东西，
    // 所以跳过从未跟进过的——否则最紧急的那条恰好没记录时，快捷键就只会报错
    const plans = await prisma.followPlan.findMany({
      where: { done: false, ownerId: user.id },
      orderBy: { plannedAt: "asc" },
      take: 10,
      select: { customer: { select: { id: true, name: true, _count: { select: { followUps: true } } } } },
    });
    if (plans.length === 0) return { ok: false, error: "你没有未完成的跟进计划，去某位" + b.customer + "的详情页安排一个" };
    const withRecord = plans.find((p) => p.customer._count.followUps > 0);
    if (!withRecord) {
      return { ok: false, error: `计划里的${b.customer}都还没有跟进记录，先录一条再让 AI 帮你准备` };
    }
    customer = { id: withRecord.customer.id, name: withRecord.customer.name };
  } else {
    const last = await prisma.followUp.findFirst({
      where: { ownerId: user.id },
      orderBy: { occurredAt: "desc" },
      select: { customer: { select: { id: true, name: true } } },
    });
    customer = last?.customer ?? null;
    if (!customer) return { ok: false, error: "你还没有任何跟进记录" };
  }

  const res = await generateBrief({
    customerId: customer.id,
    question: intent === "prep" ? "我马上要按计划联系这位，这次该谈什么？" : "上次和这位聊到哪了，有什么没接住的？",
  });
  if (!res.ok) return res;
  return { ok: true, answer: { kind: "customer", customerId: customer.id, customerName: customer.name, brief: res.brief } };
}
