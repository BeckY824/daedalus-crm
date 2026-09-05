"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { STAGE_PROBABILITY, OPP_STAGES, OPP_STATUSES } from "@/lib/constants";

export async function saveOpportunity(input: {
  id?: string;
  name: string;
  customerId: string;
  amount: number;
  stage: string;
  status: string;
  probability: number;
  expectedDealAt?: string | null;
  remark?: string | null;
  ownerId: string;
}) {
  await requireUser();
  // 与签约金额同一类问题：负数商机会让漏斗和加权预测的合计变小甚至为负
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    return { ok: false as const, error: "商机金额不能为负数" };
  }
  // 概率参与加权预测金额的计算，越界会让预测数字失真
  if (!Number.isFinite(input.probability) || input.probability < 0 || input.probability > 100) {
    return { ok: false as const, error: "成交概率必须在 0~100 之间" };
  }
  if (!OPP_STAGES.includes(input.stage as (typeof OPP_STAGES)[number])) {
    return { ok: false as const, error: `商机阶段「${input.stage}」不是合法取值` };
  }
  if (!OPP_STATUSES.includes(input.status as (typeof OPP_STATUSES)[number])) {
    return { ok: false as const, error: `商机状态「${input.status}」不是合法取值` };
  }
  const data = {
    name: input.name.trim(),
    customerId: input.customerId,
    amount: Math.round(input.amount),
    stage: input.stage,
    status: input.status,
    probability: input.probability ?? STAGE_PROBABILITY[input.stage] ?? 20,
    expectedDealAt: input.expectedDealAt ? new Date(input.expectedDealAt) : null,
    remark: input.remark || null,
    ownerId: input.ownerId,
  };

  if (input.id) await prisma.opportunity.update({ where: { id: input.id }, data });
  else await prisma.opportunity.create({ data });

  revalidatePath("/opportunities");
  revalidatePath("/opportunities/pipeline");
  revalidatePath("/dashboard");
  revalidatePath(`/customers/${input.customerId}`);
  return { ok: true as const };
}

/** 拖拽/下拉切换阶段 */
export async function moveStage(id: string, stage: string) {
  await requireUser();
  if (!OPP_STAGES.includes(stage as (typeof OPP_STAGES)[number])) {
    return { ok: false as const, error: `商机阶段「${stage}」不是合法取值` };
  }
  const before = await prisma.opportunity.findUnique({ where: { id }, select: { status: true } });
  if (!before) return { ok: false as const, error: "商机不存在，可能已被其他人删除" };

  /**
   * 已丢单的商机不因为换个阶段就复活。
   * 原本写死 status = stage === "赢单成交" ? "WON" : "OPEN"，
   * 于是把一张 LOST 的卡片拖回任意阶段，它就被静默改回进行中，
   * 重新计入漏斗和预测金额——丢单记录凭空消失，没人会注意到。
   */
  const status = stage === "赢单成交" ? "WON" : before.status === "LOST" ? "LOST" : "OPEN";
  const o = await prisma.opportunity.update({
    where: { id },
    data: { stage, probability: STAGE_PROBABILITY[stage] ?? 20, status },
  });
  revalidatePath("/opportunities");
  revalidatePath("/opportunities/pipeline");
  revalidatePath("/dashboard");
  revalidatePath(`/customers/${o.customerId}`);
  return { ok: true as const };
}

export async function setOppStatus(id: string, status: "OPEN" | "WON" | "LOST") {
  await requireUser();
  const o = await prisma.opportunity.update({
    where: { id },
    data: {
      status,
      ...(status === "WON" ? { stage: "赢单成交", probability: 100 } : {}),
      ...(status === "LOST" ? { probability: 0 } : {}),
    },
  });
  revalidatePath("/opportunities");
  revalidatePath("/opportunities/pipeline");
  revalidatePath("/dashboard");
  revalidatePath(`/customers/${o.customerId}`);
  return { ok: true as const };
}

export async function deleteOpportunities(ids: string[]) {
  await requireUser();
  await prisma.opportunity.deleteMany({ where: { id: { in: ids } } });
  revalidatePath("/opportunities");
  revalidatePath("/opportunities/pipeline");
  revalidatePath("/dashboard");
  return { ok: true as const };
}
