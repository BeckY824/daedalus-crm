"use server";

import { prisma } from "@/lib/prisma";
import { 客户关键词条件 } from "@/lib/search-keyword";
import { scheduleValue, scheduleOrder, earliestScheduled } from "@/lib/schedule-date";
import { requireUser } from "@/lib/auth";
import { 号码脱敏器 } from "@/lib/shared-ws/current";

/**
 * 列表页上「新建计划 / 记录跟进」先挑人用的两个读取（2026-09-29）。
 *
 * 原来这两个按钮直接跳去客户列表，理由是「排计划要在记录页上做，那儿才知道上次谈到哪儿」。
 * 可按钮写着「新建」却把人带走了，用户当成 bug 报上来。现在就地弹框，
 * 第一格挑人，挑完把「上次谈到哪儿」那一行带进框里——原设计要的上下文还在，只是不用跳页。
 */

export type 可挑客户 = { id: string; name: string; 附注: string | null };

/**
 * 按名字 / 公司 / 电话搜，走服务端：客户可能上千，不能一打开就把全表拉进下拉。
 * 没输字时给最近跟进过的几位——多半就是要记的那一位。
 */
export async function 搜客户(关键词: string): Promise<可挑客户[]> {
  await requireUser();
  if (typeof 关键词 !== "string") return [];
  const 词 = 关键词.trim().slice(0, 50);
  const 号 = await 号码脱敏器();
  const rows = await prisma.customer.findMany({
    where: await 客户关键词条件(词, true),
    orderBy: [{ lastFollowAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    take: 词 ? 20 : 8,
    select: { id: true, name: true, school: true, phone: true },
  });
  // 同名的人靠公司和号码分；共享工作区里号码照样打码（lib/shared-ws/current.ts）
  return rows.map((c) => ({ id: c.id, name: c.name, 附注: [c.school, 号(c.phone)].filter(Boolean).join(" · ") || null }));
}

/** 编辑已选客户时补回单个显示标签，仍经过租户/业务员限定及共享号码打码。 */
export async function 取客户选项(id: string): Promise<可挑客户 | null> {
  await requireUser();
  if (typeof id !== "string" || !id || id.length > 256) return null;
  const c = await prisma.customer.findUnique({ where: { id }, select: { id: true, name: true, school: true, phone: true } });
  if (!c) return null;
  const 号 = await 号码脱敏器();
  return { id: c.id, name: c.name, 附注: [c.school, 号(c.phone)].filter(Boolean).join(" · ") || null };
}

export type 客户近况 = {
  id: string;
  name: string;
  上次跟进: { occurredAt: string; type: string; title: string; content: string } | null;
  /** 最早的那条没做完的计划——和记录页「下次跟进」那一块取的是同一条 */
  未完成计划: { id: string; subject: string; plannedAt: string; method: string } | null;
  /** 没做完的计划一共几条（记录页只摆最早那条，多出来的要在框里说一声） */
  未完成计划数: number;
  contacts: { id: string; name: string; position: string | null }[];
  opportunities: { id: string; name: string }[];
  /** 这位客户的订单（2026-10-05，跟进能挂订单）。新的在前 */
  orders: { id: string; no: string }[];
};

/** 挑中一位之后取回来的东西：框里那行淡字，和跟进表单要的联系人、商机 */
export async function 取客户近况(id: string): Promise<客户近况 | null> {
  await requireUser();
  const c = await prisma.customer.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      followUps: { orderBy: { occurredAt: "desc" }, take: 1, select: { occurredAt: true, type: true, title: true, content: true } },
      plans: { where: { done: false }, orderBy: [{ plannedAt: "asc" }, { id: "asc" }], select: { id: true, subject: true, plannedAt: true, plannedOn: true, method: true } },
      _count: { select: { plans: { where: { done: false } } } },
      contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }], select: { id: true, name: true, position: true } },
      opportunities: { orderBy: { createdAt: "desc" }, select: { id: true, name: true } },
      tradeOrders: { orderBy: { createdAt: "desc" }, select: { id: true, no: true } },
    },
  });
  if (!c) return null;
  const f = c.followUps[0];
  const p = earliestScheduled(c.plans, p => scheduleOrder(p.plannedAt, p.plannedOn), 1)[0];
  return {
    id: c.id,
    name: c.name,
    上次跟进: f ? { occurredAt: f.occurredAt.toISOString(), type: f.type, title: f.title, content: f.content } : null,
    未完成计划: p ? { id: p.id, subject: p.subject, plannedAt: scheduleValue(p.plannedAt, p.plannedOn)!, method: p.method } : null,
    未完成计划数: c._count.plans,
    contacts: c.contacts,
    opportunities: c.opportunities,
    orders: c.tradeOrders,
  };
}
