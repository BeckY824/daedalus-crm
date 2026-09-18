"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { FOLLOW_TYPES, FOLLOW_RECORD_STATUSES } from "@/lib/constants";
import { recordAudit } from "@/lib/audit";
import { dayjs } from "@/lib/utils";

/**
 * 这一页上的写操作也要留痕。
 *
 * 跟进、待办、计划、联系人过去一条日志都不记——而它们恰恰是天天在动的东西：
 * 一条跟进被谁改了、谁把待办删了，删完界面上什么都不剩，没有任何地方能回答。
 * 「全员可见可改」成立的前提是有据可查（见 lib/audit.ts），那就不能只覆盖客户和合同。
 */
async function 客户名(id: string): Promise<string> {
  const c = await prisma.customer.findUnique({ where: { id }, select: { name: true } });
  return c?.name ?? id;
}

/** 跟进类型在界面上叫什么。日志给人看，不写 CALL 这种值 */
function 类型名(v: string): string {
  return FOLLOW_TYPES.find((t) => t.value === v)?.label ?? v;
}

/* ---------------- 跟进记录 ---------------- */

export type FollowUpInput = {
  id?: string;
  customerId: string;
  type: string;
  /** 选填。数据库列是 NOT NULL，空的时候存空串——不为此改表结构 */
  title?: string | null;
  content: string;
  status: string;
  durationMinutes?: number | null;
  occurredAt: string;
  dueAt?: string | null;
  contactId?: string | null;
  opportunityId?: string | null;
  participants?: string | null;
  /**
   * 速记解析时粘贴的原文（聊天记录 / 口述）。只在新建且经 AI 起草时有值，
   * 存进 FollowUpSource 供简报、唤醒话术引用原话；编辑时忽略，原文不可改写
   */
  sourceText?: string | null;
};

/** 原文最多存这么多字，与速记解析的输入上限一致 */
const SOURCE_TEXT_MAX = 5000;

export async function saveFollowUp(input: FollowUpInput) {
  const user = await requireUser();

  // 界面上选不出来，但接口直调能写进去，会污染看板按类型/状态的统计
  if (!FOLLOW_TYPES.some((t) => t.value === input.type)) {
    return { ok: false as const, error: `跟进类型「${input.type}」不是合法取值` };
  }
  if (!FOLLOW_RECORD_STATUSES.includes(input.status as (typeof FOLLOW_RECORD_STATUSES)[number])) {
    return { ok: false as const, error: `记录状态「${input.status}」不是合法取值` };
  }
  // 负数时长会让「累计通话时长」越统计越少
  if (input.durationMinutes != null && !(Number.isFinite(input.durationMinutes) && input.durationMinutes >= 0)) {
    return { ok: false as const, error: "通话时长不能为负数" };
  }

  const data = {
    type: input.type,
    title: input.title?.trim() ?? "",
    content: input.content.trim(),
    status: input.status,
    duration: input.durationMinutes ? Math.round(input.durationMinutes * 60) : null,
    occurredAt: new Date(input.occurredAt),
    dueAt: input.dueAt ? new Date(input.dueAt) : null,
    contactId: input.contactId || null,
    opportunityId: input.opportunityId || null,
    participants: input.participants || null,
    customerId: input.customerId,
  };

  const 姓名 = await 客户名(input.customerId);
  if (input.id) {
    /**
     * 编辑时不能重写 ownerId。
     * 原本每次保存都盖成当前登录人，于是乙帮甲改个错字，
     * 这条跟进记录就变成乙做的了——「谁跟进的」和按人统计的跟进量一起失真，
     * 而且没有任何痕迹。归属只在创建时确定。
     */
    await prisma.followUp.update({ where: { id: input.id }, data });
    await recordAudit({
      user, action: "update", entity: "FollowUp", entityId: input.id,
      summary: `修改${姓名}的一条${类型名(data.type)}跟进（${dayjs(data.occurredAt).format("YYYY-MM-DD")}）`,
      detail: { 客户: 姓名, 类型: 类型名(data.type), 状态: data.status, 内容: data.content.slice(0, 120) },
    });
  } else {
    const sourceText = input.sourceText?.trim().slice(0, SOURCE_TEXT_MAX);
    const f = await prisma.followUp.create({
      data: {
        ...data,
        ownerId: user.id,
        source: sourceText ? { create: { text: sourceText } } : undefined,
      },
    });
    await recordAudit({
      user, action: "create", entity: "FollowUp", entityId: f.id,
      summary: `记了${姓名}的一条${类型名(data.type)}跟进（${dayjs(data.occurredAt).format("YYYY-MM-DD")}）`,
      detail: { 客户: 姓名, 类型: 类型名(data.type), 状态: data.status, 内容: data.content.slice(0, 120) },
    });
  }

  // 同步客户的「最近跟进」时间
  const latest = await prisma.followUp.findFirst({
    where: { customerId: input.customerId },
    orderBy: { occurredAt: "desc" },
    select: { occurredAt: true },
  });
  await prisma.customer.update({
    where: { id: input.customerId },
    data: { lastFollowAt: latest?.occurredAt ?? null },
  });

  revalidatePath(`/customers/${input.customerId}`);
  revalidatePath("/follow-ups");
  revalidatePath("/dashboard");
  return { ok: true as const };
}

export async function deleteFollowUp(id: string, customerId: string) {
  const me = await requireUser();
  // 删之前先取内容：删完这条记录就无从还原了
  const 待删 = await prisma.followUp.findUnique({ where: { id }, select: { type: true, content: true, occurredAt: true } });
  await prisma.followUp.delete({ where: { id } });
  await recordAudit({
    user: me, action: "delete", entity: "FollowUp", entityId: id,
    summary: `删除${await 客户名(customerId)}的一条${类型名(待删?.type ?? "")}跟进（${待删 ? dayjs(待删.occurredAt).format("YYYY-MM-DD") : ""}）`,
    detail: { 类型: 类型名(待删?.type ?? ""), 内容: 待删?.content?.slice(0, 200) ?? null },
  });

  const latest = await prisma.followUp.findFirst({
    where: { customerId },
    orderBy: { occurredAt: "desc" },
    select: { occurredAt: true },
  });
  await prisma.customer.update({
    where: { id: customerId },
    data: { lastFollowAt: latest?.occurredAt ?? null },
  });

  revalidatePath(`/customers/${customerId}`);
  revalidatePath("/follow-ups");
  return { ok: true as const };
}

/* ---------------- 待办任务 ---------------- */

export async function saveTask(input: {
  id?: string;
  customerId: string;
  title: string;
  dueAt?: string | null;
}) {
  const user = await requireUser();
  const data = {
    title: input.title.trim(),
    dueAt: input.dueAt ? new Date(input.dueAt) : null,
    customerId: input.customerId,
  };
  // 同跟进记录：编辑别人的待办不该把负责人改成自己
  const 姓名 = await 客户名(input.customerId);
  if (input.id) {
    await prisma.task.update({ where: { id: input.id }, data });
    await recordAudit({ user, action: "update", entity: "Task", entityId: input.id, summary: `修改${姓名}的待办「${data.title}」`, detail: data });
  } else {
    const t = await prisma.task.create({ data: { ...data, ownerId: user.id } });
    await recordAudit({ user, action: "create", entity: "Task", entityId: t.id, summary: `给${姓名}加了待办「${data.title}」`, detail: data });
  }

  revalidatePath(`/customers/${input.customerId}`);
  revalidatePath("/dashboard");
  revalidatePath("/follow-ups/plans");
  return { ok: true as const };
}

export async function toggleTask(id: string, done: boolean) {
  const me = await requireUser();
  const t = await prisma.task.update({
    where: { id },
    data: { done, doneAt: done ? new Date() : null },
  });
  await recordAudit({
    user: me, action: "update", entity: "Task", entityId: id,
    summary: `待办「${t.title}」标记为${done ? "已完成" : "未完成"}`,
  });
  revalidatePath(`/customers/${t.customerId}`);
  revalidatePath("/dashboard");
  revalidatePath("/follow-ups/plans");
  return { ok: true as const };
}

export async function deleteTask(id: string) {
  const me = await requireUser();
  const t = await prisma.task.delete({ where: { id } });
  await recordAudit({
    user: me, action: "delete", entity: "Task", entityId: id,
    summary: `删除${await 客户名(t.customerId)}的待办「${t.title}」`,
    detail: { 标题: t.title, 截止: t.dueAt ? dayjs(t.dueAt).format("YYYY-MM-DD") : null, 已完成: t.done },
  });
  revalidatePath(`/customers/${t.customerId}`);
  revalidatePath("/dashboard");
  revalidatePath("/follow-ups/plans");
  return { ok: true as const };
}

/* ---------------- 下次跟进计划 ---------------- */

export async function savePlan(input: {
  id?: string;
  customerId: string;
  subject: string;
  plannedAt: string;
  method: string;
}) {
  const user = await requireUser();
  const data = {
    subject: input.subject.trim(),
    plannedAt: new Date(input.plannedAt),
    method: input.method,
    customerId: input.customerId,
  };
  const 姓名 = await 客户名(input.customerId);
  const 说 = `${dayjs(data.plannedAt).format("YYYY-MM-DD")} ${data.method}·${data.subject}`;
  if (input.id) {
    await prisma.followPlan.update({ where: { id: input.id }, data });
    await recordAudit({ user, action: "update", entity: "FollowPlan", entityId: input.id, summary: `修改${姓名}的跟进计划（${说}）`, detail: data });
  } else {
    const pl = await prisma.followPlan.create({ data: { ...data, ownerId: user.id } });
    await recordAudit({ user, action: "create", entity: "FollowPlan", entityId: pl.id, summary: `给${姓名}排了跟进计划（${说}）`, detail: data });
  }

  revalidatePath(`/customers/${input.customerId}`);
  revalidatePath("/follow-ups/plans");
  return { ok: true as const };
}

export async function completePlan(id: string) {
  const me = await requireUser();
  const p = await prisma.followPlan.update({ where: { id }, data: { done: true } });
  await recordAudit({
    user: me, action: "update", entity: "FollowPlan", entityId: id,
    summary: `完成跟进计划「${p.subject}」（${await 客户名(p.customerId)}）`,
  });
  revalidatePath(`/customers/${p.customerId}`);
  revalidatePath("/follow-ups/plans");
  return { ok: true as const };
}

/* ---------------- 联系人 ---------------- */

export async function saveContact(input: {
  id?: string;
  customerId: string;
  name: string;
  position?: string | null;
  phone?: string | null;
  email?: string | null;
  wechat?: string | null;
  isPrimary: boolean;
  remark?: string | null;
}) {
  const me = await requireUser();
  const data = {
    name: input.name.trim(),
    position: input.position || null,
    phone: input.phone || null,
    email: input.email || null,
    wechat: input.wechat || null,
    isPrimary: input.isPrimary,
    remark: input.remark || null,
    customerId: input.customerId,
  };
  /**
   * 「主要联系人」全客户只能有一个。
   * 原本只是照着表单写 isPrimary，谁都能把自己那条勾成主要，
   * 两个人各自勾一条就会同时存在两个主要联系人；详情页按 isPrimary 倒序取第一条，
   * 显示哪一个取决于创建顺序，看上去像是对方的修改没生效。
   */
  const 落库id = await prisma.$transaction(async (tx) => {
    const saved = input.id
      ? await tx.contact.update({ where: { id: input.id }, data })
      : await tx.contact.create({ data });
    if (input.isPrimary) {
      await tx.contact.updateMany({
        where: { customerId: input.customerId, id: { not: saved.id }, isPrimary: true },
        data: { isPrimary: false },
      });
    }
    return saved.id;
  });
  await recordAudit({
    user: me, action: input.id ? "update" : "create", entity: "Contact", entityId: 落库id,
    summary: `${input.id ? "修改" : "新建"}${await 客户名(input.customerId)}的联系人「${data.name}」${input.isPrimary ? "（主要联系人）" : ""}`,
    detail: { 姓名: data.name, 职位: data.position, 电话: data.phone, 微信: data.wechat, 主要联系人: data.isPrimary },
  });

  revalidatePath(`/customers/${input.customerId}`);
  revalidatePath("/contacts");
  return { ok: true as const };
}

export async function deleteContact(id: string) {
  const me = await requireUser();
  const c = await prisma.contact.delete({ where: { id } });
  await recordAudit({
    user: me, action: "delete", entity: "Contact", entityId: id,
    summary: `删除${await 客户名(c.customerId)}的联系人「${c.name}」`,
    detail: { 姓名: c.name, 职位: c.position, 电话: c.phone },
  });
  revalidatePath(`/customers/${c.customerId}`);
  revalidatePath("/contacts");
  return { ok: true as const };
}
