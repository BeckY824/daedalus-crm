"use server";

import { 不在了 } from "@/lib/not-there";
import { 版本冲突, 版本条件 } from "@/lib/edit-version";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { STAGE_PROBABILITY, OPP_STAGES, OPP_STATUSES } from "@/lib/constants";
import { 对齐阶段与状态 } from "@/lib/opp-stage";
import { recordAudit } from "@/lib/audit";
import { 唯一负责人 } from "@/lib/owners";

/** 状态在界面上叫什么。日志是给人看的，不能写 WON / LOST */
const 状态名: Record<string, string> = { OPEN: "进行中", WON: "赢单", LOST: "丢单" };

/** 商机一动，列表、看板、首页数字都得重算；带上客户就连那张详情页一起 */
function 刷新商机(客户id?: string) {
  for (const p of ["/opportunities", "/opportunities/pipeline", "/dashboard"]) revalidatePath(p);
  if (客户id) revalidatePath(`/customers/${客户id}`);
}

/**
 * 记下 / 撤掉结单时刻（排查 C6）。变成赢单或丢单的那一下记一笔；回到进行中就删掉；
 * 本来就是这个状态（改个备注）不碰——「本月赢单」按它数，不能因为改备注就挪到本月。
 */
async function 记结单(id: string, 原状态: string | null, 新状态: string) {
  if (新状态 === "OPEN") {
    await prisma.opportunityClose.deleteMany({ where: { opportunityId: id } });
    return;
  }
  if (原状态 === 新状态) return;
  await prisma.opportunityClose.upsert({
    where: { opportunityId: id },
    create: { opportunityId: id, closedAt: new Date() },
    update: { closedAt: new Date() },
  });
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
  /** 打开编辑框那一刻的 updatedAt。给了就当闸门：期间有人改过不盖掉（排查 D3） */
  版本?: string | null;
}) {
  const me = await requireUser();
  // 名字只有空格不收（第二轮 r2-data：原来存出一条没有名字的）
  if (!String(input.name ?? "").trim()) return { ok: false as const, error: "请填写商机名称" };
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
  /*
    阶段和状态绑在一起（排查 C6）：阶段是「赢单成交」就是赢单，标了赢单阶段就是「赢单成交」。
    原来可以存出「进行中 + 赢单成交」：数据页「进行中商机」算它、漏斗前四档没有它、管道的赢单列里却躺着一张进行中的卡。
    丢单不限阶段——丢在哪一步本身有用。
  */
  const 原 = input.id ? await prisma.opportunity.findUnique({ where: { id: input.id }, select: { status: true, stage: true } }) : null;
  const 原状态 = 原?.status ?? null;
  input = { ...input, ...对齐阶段与状态(input, 原) };
  // 从赢单成交退回来、概率还挂着 100 的：跟着新阶段走（100% 的进行中商机会把预测金额整笔算进去）
  if (原?.stage === "赢单成交" && input.stage !== "赢单成交" && input.probability === 100) {
    input = { ...input, probability: STAGE_PROBABILITY[input.stage] ?? 20 };
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
    ownerId,
  };

  if (input.id) {
    const 写了 = await prisma.opportunity.updateMany({ where: { id: input.id, ...版本条件(input.版本) }, data });
    if (写了.count === 0) {
      return { ok: false as const, error: 原状态 === null ? "这个商机已经不在了（可能已删除）" : 版本冲突 };
    }
    await 记结单(input.id, 原状态, data.status);
    await recordAudit({
      user: me, action: "update", entity: "Opportunity", entityId: input.id,
      summary: `修改商机「${data.name}」：${data.stage} · ${状态名[data.status] ?? data.status} · ¥${data.amount}`,
      detail: { 名称: data.name, 金额: data.amount, 阶段: data.stage, 状态: 状态名[data.status] ?? data.status, 概率: data.probability },
    });
  } else {
    const o = await prisma.opportunity.create({ data });
    await 记结单(o.id, null, data.status);
    await recordAudit({
      user: me, action: "create", entity: "Opportunity", entityId: o.id,
      summary: `新建商机「${data.name}」：${data.stage} · ¥${data.amount}`,
      detail: { 名称: data.name, 金额: data.amount, 阶段: data.stage, 状态: 状态名[data.status] ?? data.status },
    });
  }

  刷新商机(input.customerId);
  return { ok: true as const };
}

/**
 * 拖拽/下拉切换阶段。
 * `还原概率` 给撤销用（排查 D6）：拖进「赢单成交」概率会变成 100，撤回去时按「人没动过才跟着变」的规矩判断，
 * 100 正是赢单成交的默认值，于是手填的 75% 被换成了目标阶段的默认值。撤销得原样撤。
 */
export async function moveStage(id: string, stage: string, 还原概率?: number) {
  try {
    const me = await requireUser();
    if (!OPP_STAGES.includes(stage as (typeof OPP_STAGES)[number])) {
      return { ok: false as const, error: `商机阶段「${stage}」不是合法取值` };
    }
    const before = await prisma.opportunity.findUnique({ where: { id }, select: { status: true, stage: true, name: true, probability: true } });
    if (!before) return { ok: false as const, error: "商机不存在（可能已删除）" };
  
    /**
     * 已丢单的商机不因为换个阶段就复活。
     * 原本写死 status = stage === "赢单成交" ? "WON" : "OPEN"，
     * 于是把一张 LOST 的卡片拖回任意阶段，它就被静默改回进行中，
     * 重新计入漏斗和预测金额——丢单记录凭空消失，没人会注意到。
     */
    const status = stage === "赢单成交" ? "WON" : before.status === "LOST" ? "LOST" : "OPEN";
    /*
      概率只在「人没动过」时跟着阶段变（审查 M11）：还等于旧阶段的默认值，才换成新阶段的默认值；
      人手填过的（蓝鲸那单的 75%）原样留着——系统帮你填的字段，人动过手就不许自动改回去。
      赢单成交一律 100。撤销（改回原阶段）也走这一条，所以撤销之后概率也回得去。
    */
    const probability =
      还原概率 !== undefined && Number.isFinite(还原概率) && 还原概率 >= 0 && 还原概率 <= 100
        ? Math.round(还原概率)
        : stage === "赢单成交" ? 100 : before.probability === (STAGE_PROBABILITY[before.stage] ?? 20) ? STAGE_PROBABILITY[stage] ?? 20 : before.probability;
    const o = await prisma.opportunity.update({
      where: { id },
      data: { stage, probability, status },
    });
    await 记结单(id, before.status, status);
    await recordAudit({
      user: me, action: "update", entity: "Opportunity", entityId: id,
      summary: `商机「${o.name}」阶段：${before.stage} → ${stage}`,
      detail: { 原阶段: before.stage, 新阶段: stage, 状态: 状态名[status] ?? status },
    });
    刷新商机(o.customerId);
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
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
  try {
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
    const 原 = await prisma.opportunity.findUnique({ where: { id }, select: { status: true } });
    if (!原) return { ok: false as const, error: "商机不存在（可能已删除）" };
    const o = await prisma.opportunity.update({
      where: { id },
      data: {
        status,
        ...(status === "WON" ? { stage: "赢单成交", probability: 100 } : {}),
        ...(status === "LOST" ? { probability: 0 } : {}),
        ...(还原 ? { stage: 还原.stage, probability: Math.round(还原.probability) } : {}),
      },
    });
    await 记结单(id, 原.status, status);
    await recordAudit({
      user: me, action: "update", entity: "Opportunity", entityId: id,
      summary: 还原 ? `商机「${o.name}」撤销改状态，回到${状态名[status] ?? status}（${o.stage}）` : `商机「${o.name}」标记为${状态名[status] ?? status}`,
      detail: { 状态: 状态名[status] ?? status, 金额: o.amount, ...(还原 ? { 阶段: o.stage, 概率: o.probability } : {}) },
    });
    刷新商机(o.customerId);
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
}

export async function deleteOpportunities(ids: string[]) {
  try {
    const me = await requireUser();
    /*
      先把名字查出来再删——删完就没得查了。
      删除是最该留痕的一种写操作：删掉的东西在界面上再也找不到，日志是唯一能回答
      「那个商机去哪了」的地方。
    */
    const 待删 = await prisma.opportunity.findMany({
      where: { id: { in: ids } },
      include: { customer: { select: { name: true } }, closed: true, followUps: { select: { id: true } } },
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
    // 撤销要用的原样快照（排查 D2）：一并记下原来指着它的跟进记录、结单时刻
    const 快照: 删掉的商机[] = 待删.map(({ customer: _客户, closed, followUps, ...o }) => ({
      ...o,
      expectedDealAt: o.expectedDealAt?.toISOString() ?? null,
      createdAt: o.createdAt.toISOString(),
      closedAt: closed?.closedAt.toISOString() ?? null,
      跟进: followUps.map((f) => f.id),
    }));
    return { ok: true as const, 快照 };
  } catch (e) {
    return 不在了(e);
  }
}

export type 删掉的商机 = {
  id: string; name: string; amount: number; stage: string; status: string; probability: number;
  expectedDealAt: string | null; remark: string | null; customerId: string; ownerId: string;
  createdAt: string; closedAt: string | null; 跟进: string[];
};

/** 删之前数一数：关联着几条跟进（删了它们就不再写是哪个商机）、有几个已经赢单（排查 D2） */
export async function 删商机前清点(ids: string[]) {
  await requireUser();
  const [跟进, 赢单] = await Promise.all([
    prisma.followUp.count({ where: { opportunityId: { in: ids } } }),
    prisma.opportunity.count({ where: { id: { in: ids }, status: "WON" } }),
  ]);
  return { 跟进, 赢单 };
}

/**
 * 撤销删除：同一个 id 原样建回来，原来指着它的跟进记录接回去（只接这会儿还空着的）。
 * 客户已经不在了的那几个撤不回来，回 没回来 的个数。
 */
export async function restoreOpportunities(快照: 删掉的商机[]) {
  try {
    const me = await requireUser();
    let 回来 = 0;
    for (const o of 快照) {
      if (await prisma.opportunity.findUnique({ where: { id: o.id }, select: { id: true } })) continue;
      if (!(await prisma.customer.findUnique({ where: { id: o.customerId }, select: { id: true } }))) continue;
      if (!OPP_STAGES.includes(o.stage as (typeof OPP_STAGES)[number]) || !OPP_STATUSES.includes(o.status as (typeof OPP_STATUSES)[number])) continue;
      await prisma.$transaction(async (tx) => {
        await tx.opportunity.create({
          data: {
            id: o.id, name: o.name, amount: o.amount, stage: o.stage, status: o.status, probability: o.probability,
            expectedDealAt: o.expectedDealAt ? new Date(o.expectedDealAt) : null, remark: o.remark,
            customerId: o.customerId, ownerId: o.ownerId, createdAt: new Date(o.createdAt),
            ...(o.closedAt ? { closed: { create: { closedAt: new Date(o.closedAt) } } } : {}),
          },
        });
        if (o.跟进.length) {
          await tx.followUp.updateMany({ where: { id: { in: o.跟进 }, opportunityId: null }, data: { opportunityId: o.id } });
        }
      });
      回来++;
    }
    if (回来) {
      await recordAudit({
        user: me, action: "create", entity: "Opportunity",
        summary: `撤销删除：${回来} 个商机回来了`,
        detail: 快照.map((o) => ({ 名称: o.name })),
      });
    }
    刷新商机();
    return { ok: true as const, 回来, 没回来: 快照.length - 回来 };
  } catch (e) {
    return 不在了(e);
  }
}

