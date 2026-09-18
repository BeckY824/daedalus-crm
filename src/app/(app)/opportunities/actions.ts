"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { STAGE_PROBABILITY, OPP_STAGES, OPP_STATUSES } from "@/lib/constants";
import { recordAudit } from "@/lib/audit";
import { 唯一负责人 } from "@/lib/owners";

/** 状态在界面上叫什么。日志是给人看的，不能写 WON / LOST */
const 状态名: Record<string, string> = { OPEN: "进行中", WON: "赢单", LOST: "丢单" };

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
  /** 一个人的工作区里界面上不问这一项，留空由服务端填成那唯一的人 */
  ownerId?: string | null;
}) {
  const me = await requireUser();
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
  const ownerId = input.ownerId || (await 唯一负责人());
  if (!ownerId) return { ok: false as const, error: "请选择负责人" };

  const data = {
    name: input.name.trim(),
    customerId: input.customerId,
    amount: Math.round(input.amount),
    stage: input.stage,
    status: input.status,
    probability: input.probability ?? STAGE_PROBABILITY[input.stage] ?? 20,
    expectedDealAt: input.expectedDealAt ? new Date(input.expectedDealAt) : null,
    remark: input.remark || null,
    ownerId,
  };

  if (input.id) {
    await prisma.opportunity.update({ where: { id: input.id }, data });
    await recordAudit({
      user: me, action: "update", entity: "Opportunity", entityId: input.id,
      summary: `修改商机「${data.name}」：${data.stage} · ${状态名[data.status] ?? data.status} · ¥${data.amount}`,
      detail: { 名称: data.name, 金额: data.amount, 阶段: data.stage, 状态: 状态名[data.status] ?? data.status, 概率: data.probability },
    });
  } else {
    const o = await prisma.opportunity.create({ data });
    await recordAudit({
      user: me, action: "create", entity: "Opportunity", entityId: o.id,
      summary: `新建商机「${data.name}」：${data.stage} · ¥${data.amount}`,
      detail: { 名称: data.name, 金额: data.amount, 阶段: data.stage, 状态: 状态名[data.status] ?? data.status },
    });
  }

  revalidatePath("/opportunities");
  revalidatePath("/opportunities/pipeline");
  revalidatePath("/dashboard");
  revalidatePath(`/customers/${input.customerId}`);
  return { ok: true as const };
}

/** 拖拽/下拉切换阶段 */
export async function moveStage(id: string, stage: string) {
  const me = await requireUser();
  if (!OPP_STAGES.includes(stage as (typeof OPP_STAGES)[number])) {
    return { ok: false as const, error: `商机阶段「${stage}」不是合法取值` };
  }
  const before = await prisma.opportunity.findUnique({ where: { id }, select: { status: true, stage: true, name: true } });
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
  await recordAudit({
    user: me, action: "update", entity: "Opportunity", entityId: id,
    summary: `商机「${o.name}」阶段：${before.stage} → ${stage}`,
    detail: { 原阶段: before.stage, 新阶段: stage, 状态: 状态名[status] ?? status },
  });
  revalidatePath("/opportunities");
  revalidatePath("/opportunities/pipeline");
  revalidatePath("/dashboard");
  revalidatePath(`/customers/${o.customerId}`);
  return { ok: true as const };
}

export async function setOppStatus(id: string, status: "OPEN" | "WON" | "LOST") {
  const me = await requireUser();
  const o = await prisma.opportunity.update({
    where: { id },
    data: {
      status,
      ...(status === "WON" ? { stage: "赢单成交", probability: 100 } : {}),
      ...(status === "LOST" ? { probability: 0 } : {}),
    },
  });
  await recordAudit({
    user: me, action: "update", entity: "Opportunity", entityId: id,
    summary: `商机「${o.name}」标记为${状态名[status] ?? status}`,
    detail: { 状态: 状态名[status] ?? status, 金额: o.amount },
  });
  revalidatePath("/opportunities");
  revalidatePath("/opportunities/pipeline");
  revalidatePath("/dashboard");
  revalidatePath(`/customers/${o.customerId}`);
  return { ok: true as const };
}

export async function deleteOpportunities(ids: string[]) {
  const me = await requireUser();
  /*
    先把名字查出来再删——删完就没得查了。
    删除是最该留痕的一种写操作：删掉的东西在界面上再也找不到，日志是唯一能回答
    「那个商机去哪了」的地方。
  */
  const 待删 = await prisma.opportunity.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, amount: true, stage: true, customer: { select: { name: true } } },
  });
  const res = await prisma.opportunity.deleteMany({ where: { id: { in: ids } } });
  if (res.count) {
    await recordAudit({
      user: me, action: "delete", entity: "Opportunity",
      summary: `删除 ${res.count} 个商机：${待删.map((o) => `「${o.name}」`).join("、")}`,
      detail: 待删.map((o) => ({ 名称: o.name, 客户: o.customer?.name ?? null, 金额: o.amount, 阶段: o.stage })),
    });
  }
  revalidatePath("/opportunities");
  revalidatePath("/opportunities/pipeline");
  revalidatePath("/dashboard");
  return { ok: true as const };
}
