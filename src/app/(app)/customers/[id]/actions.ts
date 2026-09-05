"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { FOLLOW_TYPES, FOLLOW_RECORD_STATUSES } from "@/lib/constants";

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
};

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

  if (input.id) {
    /**
     * 编辑时不能重写 ownerId。
     * 原本每次保存都盖成当前登录人，于是乙帮甲改个错字，
     * 这条跟进记录就变成乙做的了——「谁跟进的」和按人统计的跟进量一起失真，
     * 而且没有任何痕迹。归属只在创建时确定。
     */
    await prisma.followUp.update({ where: { id: input.id }, data });
  } else {
    await prisma.followUp.create({ data: { ...data, ownerId: user.id } });
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
  await requireUser();
  await prisma.followUp.delete({ where: { id } });

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
  if (input.id) await prisma.task.update({ where: { id: input.id }, data });
  else await prisma.task.create({ data: { ...data, ownerId: user.id } });

  revalidatePath(`/customers/${input.customerId}`);
  revalidatePath("/dashboard");
  revalidatePath("/follow-ups/plans");
  return { ok: true as const };
}

export async function toggleTask(id: string, done: boolean) {
  await requireUser();
  const t = await prisma.task.update({
    where: { id },
    data: { done, doneAt: done ? new Date() : null },
  });
  revalidatePath(`/customers/${t.customerId}`);
  revalidatePath("/dashboard");
  revalidatePath("/follow-ups/plans");
  return { ok: true as const };
}

export async function deleteTask(id: string) {
  await requireUser();
  const t = await prisma.task.delete({ where: { id } });
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
  if (input.id) await prisma.followPlan.update({ where: { id: input.id }, data });
  else await prisma.followPlan.create({ data: { ...data, ownerId: user.id } });

  revalidatePath(`/customers/${input.customerId}`);
  revalidatePath("/follow-ups/plans");
  return { ok: true as const };
}

export async function completePlan(id: string) {
  await requireUser();
  const p = await prisma.followPlan.update({ where: { id }, data: { done: true } });
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
  await requireUser();
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
  await prisma.$transaction(async (tx) => {
    const saved = input.id
      ? await tx.contact.update({ where: { id: input.id }, data })
      : await tx.contact.create({ data });
    if (input.isPrimary) {
      await tx.contact.updateMany({
        where: { customerId: input.customerId, id: { not: saved.id }, isPrimary: true },
        data: { isPrimary: false },
      });
    }
  });

  revalidatePath(`/customers/${input.customerId}`);
  revalidatePath("/contacts");
  return { ok: true as const };
}

export async function deleteContact(id: string) {
  await requireUser();
  const c = await prisma.contact.delete({ where: { id } });
  revalidatePath(`/customers/${c.customerId}`);
  revalidatePath("/contacts");
  return { ok: true as const };
}
