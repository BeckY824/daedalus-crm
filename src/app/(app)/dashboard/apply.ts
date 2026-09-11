"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { recordAudit } from "@/lib/audit";
import { buildProposal, summarizeApplied, type Proposal } from "@/lib/agent/proposals";
import { patchCustomer } from "../customers/actions";
import { saveFollowUp, savePlan } from "../customers/[id]/actions";

export type ApplyResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * 确认一张 AI 建议卡，把它真的写进去。
 *
 * 这是 AI 参与写入的唯一入口，也是唯一一处「模型的输出会落库」的地方，所以两条铁律：
 *   1. 传进来的东西一律不可信——卡片上的值人可以随便改，所以在这里用和生成时同一套
 *      校验（buildProposal）重新收一遍，而不是信前端说它合法
 *   2. 真正的写入仍然走原有的 server action，权限、查重、留痕、revalidate 全部复用，
 *      不给 AI 开任何旁路
 * 落库后额外记一条 ai_apply，和 ai_use 分开：一个是"调了模型"，一个是"人批准了模型的建议"。
 */
export async function applyProposal(input: Proposal): Promise<ApplyResult> {
  const me = await requireUser();
  const b = await getBusiness();

  const c = await prisma.customer.findUnique({ where: { id: String(input?.customerId ?? "") }, select: { id: true, name: true } });
  if (!c) return { ok: false, error: `这条${b.customer}已被删除` };

  // 人改过的值和模型给的值一样不可信，重新校验一遍
  const checked = buildProposal(input.id, input.kind, c, input as unknown as Record<string, unknown>);
  if (!checked.ok) return { ok: false, error: checked.error };
  const p = checked.proposal;

  let done: { ok: true } | { ok: false; error: string };
  if (p.kind === "set_status") {
    done = await patchCustomer(p.customerId, p.field, p.to);
  } else if (p.kind === "add_followup") {
    const r = await saveFollowUp({
      customerId: p.customerId,
      type: p.type,
      title: p.title || null,
      content: p.content,
      status: "已完成",
      occurredAt: p.occurredAt,
    });
    done = r.ok ? { ok: true } : { ok: false, error: r.error };
  } else {
    const r = await savePlan({ customerId: p.customerId, subject: p.subject, plannedAt: p.plannedAt, method: p.method });
    done = r.ok ? { ok: true } : { ok: false, error: "计划没能保存" };
  }
  if (!done.ok) return done;

  const summary = summarizeApplied(p, b.customer);
  await recordAudit({ user: me, action: "ai_apply", entity: "Ai", entityId: p.kind, summary, detail: { 对象: c.name, 理由: p.reason } });
  return { ok: true, message: summary.replace("确认 AI 建议：", "已") };
}
