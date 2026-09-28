"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { STAGE_PROBABILITY, OPP_STAGES, OPP_STATUSES } from "@/lib/constants";
import { recordAudit } from "@/lib/audit";
import { 唯一负责人 } from "@/lib/owners";

/** 状态在界面上叫什么。日志是给人看的，不能写 WON / LOST */
const 状态名: Record<string, string> = { OPEN: "进行中", WON: "赢单", LOST: "丢单" };

/** 商机一动，列表、看板、首页数字都得重算；带上客户就连那张详情页一起 */
function 刷新商机(客户id?: string) {
  for (const p of ["/opportunities", "/opportunities/pipeline", "/dashboard"]) revalidatePath(p);
  if (客户id) revalidatePath(`/customers/${客户id}`);
}

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

  刷新商机(input.customerId);
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
  刷新商机(o.customerId);
  return { ok: true as const };
}

/**
 * 改商机状态。
 *
 * `还原` 给撤销用：标丢单会把概率清零、标赢单会把阶段推到「赢单成交」，
 * 只把 status 改回 OPEN 的话，阶段和人手填的概率就回不来了——撤销得原样撤。
 */
export async function setOppStatus(
  id: string,
  status: "OPEN" | "WON" | "LOST",
  还原?: { stage: string; probability: number },
) {
  const me = await requireUser();
  if (!OPP_STATUSES.includes(status)) return { ok: false as const, error: `商机状态「${status}」不是合法取值` };
  if (还原) {
    if (!OPP_STAGES.includes(还原.stage as (typeof OPP_STAGES)[number])) {
      return { ok: false as const, error: `商机阶段「${还原.stage}」不是合法取值` };
    }
    if (!Number.isFinite(还原.probability) || 还原.probability < 0 || 还原.probability > 100) {
      return { ok: false as const, error: "成交概率必须在 0~100 之间" };
    }
  }
  const o = await prisma.opportunity.update({
    where: { id },
    data: {
      status,
      ...(status === "WON" ? { stage: "赢单成交", probability: 100 } : {}),
      ...(status === "LOST" ? { probability: 0 } : {}),
      ...(还原 ? { stage: 还原.stage, probability: Math.round(还原.probability) } : {}),
    },
  });
  await recordAudit({
    user: me, action: "update", entity: "Opportunity", entityId: id,
    summary: 还原 ? `商机「${o.name}」撤销改状态，回到${状态名[status] ?? status}（${o.stage}）` : `商机「${o.name}」标记为${状态名[status] ?? status}`,
    detail: { 状态: 状态名[status] ?? status, 金额: o.amount, ...(还原 ? { 阶段: o.stage, 概率: o.probability } : {}) },
  });
  刷新商机(o.customerId);
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
  刷新商机();
  return { ok: true as const };
}
