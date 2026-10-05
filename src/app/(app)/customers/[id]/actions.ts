"use server";

import { 不在了 } from "@/lib/not-there";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import { requireUser } from "@/lib/auth";
import { FOLLOW_TYPES, FOLLOW_RECORD_STATUSES } from "@/lib/constants";
import { recordAudit } from "@/lib/audit";
import { 认回打码号 } from "@/lib/phone";
import { 版本冲突, 版本条件, 推进版本 } from "@/lib/edit-version";
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

/** 待办会出现在首页和计划页上 */
function 刷新待办(客户id: string) {
  for (const p of [`/customers/${客户id}`, "/dashboard", "/follow-ups/plans"]) revalidatePath(p);
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
  /**
   * 挂在哪张订单上（2026-10-05 外贸客户建议：「关联商机改成关联商机 / 关联订单，可以关联到订单号」）。
   * undefined = 不碰；null = 不挂了；给了 id 就挂上（整单，不挂某一步）
   */
  orderId?: string | null;
  participants?: string | null;
  /**
   * 速记解析时粘贴的原文（聊天记录 / 口述）。只在新建且经 AI 起草时有值，
   * 存进 FollowUpSource 供简报、唤醒话术引用原话；编辑时忽略，原文不可改写
   */
  sourceText?: string | null;
  /**
   * 编辑框打开那一刻这条的 updatedAt（2026-10-04 J-105）。给了就当版本闸门：期间这条被改过（另一个窗口、同事），
   * 一格都不写、说一句；不给（AI 卡片、订单节点这些程序里调的）照旧直接写
   */
  版本?: string | null;
};

/** 原文最多存这么多字，与速记解析的输入上限一致 */
const SOURCE_TEXT_MAX = 5000;

/**
 * 「跟进提醒 / 跟进任务」顺带建的那条待办（2026-10-02 排查 3-2）。没有外键连着——认它靠「同一位客户、
 * 同一个标题、同一个时间、还没做」。跟进删了、改成已完成、改了时间，这条待办要跟着（复查 R：原来跟进删了待办照样到点提醒）
 */
type 带时间的跟进 = { type: string; title: string; content: string; status: string; dueAt: Date | null };
const 会带待办 = (f: 带时间的跟进) => (f.type === "TASK" || f.type === "REMIND") && Boolean(f.dueAt);
const 待办标题 = (f: 带时间的跟进) => (f.title || f.content).trim().slice(0, 60) || 类型名(f.type);
async function 跟着改待办(customerId: string, 旧: 带时间的跟进, 新: 带时间的跟进 | null) {
  if (!会带待办(旧)) return;
  /*
    只动**一条**（第三轮复查）：原来 deleteMany / updateMany，两条同标题同时间的提醒删一条，两条待办都没了，
    人手建的同名同时间待办也被带走。一条跟进只顺带建过一条待办，就只认最早那一条
  */
  const 那条 = await prisma.task.findFirst({
    where: { customerId, title: 待办标题(旧), dueAt: 旧.dueAt!, done: false },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!那条) return;
  if (!新 || !会带待办(新)) {
    await prisma.task.delete({ where: { id: 那条.id } });
  } else if (新.status === "已完成") {
    await prisma.task.update({ where: { id: 那条.id }, data: { done: true, doneAt: new Date() } });
  } else {
    await prisma.task.update({ where: { id: 那条.id }, data: { title: 待办标题(新), dueAt: 新.dueAt } });
  }
  刷新待办(customerId);
}

/**
 * 跟进挂到订单上 / 摘下来。只认这位客户自己的订单（id 是从浏览器来的）。
 * 原来挂在某一步（节点开着时记的）的，换订单才改成整单（nodeIdx 0），没换就留着原来那一步
 */
async function 挂订单(followUpId: string, customerId: string, orderId: string | null) {
  const 原 = await prisma.followUpOrder.findUnique({ where: { followUpId } });
  if (!orderId) {
    if (原) await prisma.followUpOrder.delete({ where: { followUpId } });
    return;
  }
  if (原?.orderId === orderId) return;
  const o = await prisma.tradeOrder.findFirst({ where: { id: orderId, customerId }, select: { id: true } });
  if (!o) return;
  await prisma.followUpOrder.upsert({ where: { followUpId }, create: { followUpId, orderId: o.id, nodeIdx: 0 }, update: { orderId: o.id, nodeIdx: 0 } });
  revalidatePath(`/orders/${o.id}`);
}

export async function saveFollowUp(input: FollowUpInput) {
  try {
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
    let id = input.id ?? "";
    /** 「跟进提醒 / 跟进任务」顺带建的那条待办 */
    let 待办id: string | undefined;
    if (input.id) {
      /**
       * 编辑时不能重写 ownerId。
       * 原本每次保存都盖成当前登录人，于是乙帮甲改个错字，
       * 这条跟进记录就变成乙做的了——「谁跟进的」和按人统计的跟进量一起失真，
       * 而且没有任何痕迹。归属只在创建时确定。
       */
      const 改前 = await prisma.followUp.findUnique({ where: { id: input.id }, select: { type: true, title: true, content: true, status: true, dueAt: true } });
      if (!改前) return { ok: false as const, error: "这条跟进已经不在了（可能在别处删了），刷新看看" };
      // 版本闸门（J-105）：原来整条 update，两个窗口改同一条，后存的把先存的改动整条盖回去、谁都不知道
      const 写了 = await prisma.followUp.updateMany({ where: { id: input.id, ...版本条件(input.版本) }, data: { ...data, ...推进版本(input.版本) } });
      if (写了.count === 0) return { ok: false as const, error: 版本冲突 };
      await 跟着改待办(input.customerId, 改前, data);
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
      id = f.id;
      await recordAudit({
        user, action: "create", entity: "FollowUp", entityId: f.id,
        summary: `记了${姓名}的一条${类型名(data.type)}跟进（${dayjs(data.occurredAt).format("YYYY-MM-DD")}）`,
        detail: { 客户: 姓名, 类型: 类型名(data.type), 状态: data.status, 内容: data.content.slice(0, 120) },
      });
      /*
        「跟进任务 / 跟进提醒」填了时间、还没做完的：同时建一条待办（2026-10-02 排查 3-2）。
        Dock 数字、早报、到点通知、计划页都只看计划和待办——原来这里填的「提醒时间」只是记录上的一格，到点什么都不会发生，
        而人选「跟进提醒」就是想被提醒。只在新建时做：编辑一条老记录不该再冒出一条待办。
      */
      if (会带待办(data) && data.status !== "已完成") {
        const t = await prisma.task.create({ data: { title: 待办标题(data), dueAt: data.dueAt!, customerId: input.customerId, ownerId: user.id } });
        待办id = t.id;
        刷新待办(input.customerId);
      }
    }
  
    if (input.orderId !== undefined) await 挂订单(id, input.customerId, input.orderId);

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
    return { ok: true as const, id, ...(待办id ? { 待办id } : {}) };
  } catch (e) {
    return 不在了(e);
  }
}

export async function deleteFollowUp(id: string, customerId: string) {
  try {
    const me = await requireUser();
    // 删之前先取内容：删完这条记录就无从还原了。整条连 AI 速记的原文一起留着，给撤销用（排查 D2）
    const 待删 = await prisma.followUp.findUnique({ where: { id }, include: { source: true, orderNode: true } });
    if (!待删) return { ok: false as const, error: "这条跟进已经不在了，刷新看看" };
    await prisma.followUp.delete({ where: { id } });
    await 跟着改待办(customerId, 待删, null);
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
    const { source, orderNode, ...行 } = 待删;
    const 快照: 删掉的跟进 = {
      ...行,
      occurredAt: 行.occurredAt.toISOString(), dueAt: 行.dueAt?.toISOString() ?? null,
      createdAt: 行.createdAt.toISOString(), updatedAt: 行.updatedAt.toISOString(),
      原文: source?.text ?? null,
      订单: orderNode ? { orderId: orderNode.orderId, nodeIdx: orderNode.nodeIdx } : null,
    };
    return { ok: true as const, 快照 };
  } catch (e) {
    return 不在了(e);
  }
}

export type 删掉的跟进 = {
  id: string; type: string; title: string; content: string; status: string; duration: number | null;
  occurredAt: string; dueAt: string | null; participants: string | null;
  customerId: string; contactId: string | null; opportunityId: string | null; ownerId: string;
  createdAt: string; updatedAt: string;
  /** AI 速记时粘贴的原文，没有就是 null */
  原文: string | null;
  /** 挂在哪张订单（哪一步）上（2026-10-05）。老快照没有这一格 */
  订单?: { orderId: string; nodeIdx: number } | null;
};

/** 撤销删除一条跟进：原样建回来，连 AI 速记的原文（排查 D2）。联系人、商机这会儿已经不在了的，那一格空着 */
export async function restoreFollowUp(快照: 删掉的跟进) {
  try {
    const me = await requireUser();
    if (await prisma.followUp.findUnique({ where: { id: 快照.id }, select: { id: true } })) return { ok: true as const };
    if (!(await prisma.customer.findUnique({ where: { id: 快照.customerId }, select: { id: true } }))) {
      return { ok: false as const, error: "这位客户已经不在了，撤不回来" };
    }
    const [联系人在, 商机在] = await Promise.all([
      快照.contactId ? prisma.contact.findUnique({ where: { id: 快照.contactId }, select: { id: true } }) : null,
      快照.opportunityId ? prisma.opportunity.findUnique({ where: { id: 快照.opportunityId }, select: { id: true } }) : null,
    ]);
    await prisma.followUp.create({
      data: {
        id: 快照.id, type: 快照.type, title: 快照.title, content: 快照.content, status: 快照.status, duration: 快照.duration,
        occurredAt: new Date(快照.occurredAt), dueAt: 快照.dueAt ? new Date(快照.dueAt) : null, participants: 快照.participants,
        customerId: 快照.customerId, contactId: 联系人在 ? 快照.contactId : null, opportunityId: 商机在 ? 快照.opportunityId : null,
        ownerId: 快照.ownerId, createdAt: new Date(快照.createdAt),
        ...(快照.原文 ? { source: { create: { text: 快照.原文 } } } : {}),
      },
    });
    // 原来挂着的订单还在就挂回去
    if (快照.订单 && (await prisma.tradeOrder.findUnique({ where: { id: 快照.订单.orderId }, select: { id: true } }))) {
      await prisma.followUpOrder.create({ data: { followUpId: 快照.id, orderId: 快照.订单.orderId, nodeIdx: 快照.订单.nodeIdx } });
    }
    // 删的时候顺带的待办一起删了：撤销时一起回来
    const 回来的 = { ...快照, dueAt: 快照.dueAt ? new Date(快照.dueAt) : null };
    if (会带待办(回来的) && 快照.status !== "已完成") {
      /*
        按条数补齐（第四轮 C1）：同标题同时间的提醒有两条、删一条再撤销时，另一条的待办还在，
        原来看到「有一条」就不补了，结果两条提醒一条待办。现在数一下这类跟进有几条，待办少几条补几条
      */
      const 标题 = 待办标题(回来的);
      const 同样的跟进 = (
        await prisma.followUp.findMany({
          where: { customerId: 快照.customerId, dueAt: 回来的.dueAt!, type: { in: ["TASK", "REMIND"] }, NOT: { status: "已完成" } },
          select: { type: true, title: true, content: true, status: true, dueAt: true },
        })
      ).filter((f) => 待办标题(f) === 标题).length;
      const 在 = await prisma.task.count({ where: { customerId: 快照.customerId, title: 标题, dueAt: 回来的.dueAt!, done: false } });
      if (在 < 同样的跟进) await prisma.task.create({ data: { title: 标题, dueAt: 回来的.dueAt!, customerId: 快照.customerId, ownerId: 快照.ownerId } });
      刷新待办(快照.customerId);
    }
    const latest = await prisma.followUp.findFirst({ where: { customerId: 快照.customerId }, orderBy: { occurredAt: "desc" }, select: { occurredAt: true } });
    await prisma.customer.update({ where: { id: 快照.customerId }, data: { lastFollowAt: latest?.occurredAt ?? null } });
    await recordAudit({
      user: me, action: "create", entity: "FollowUp", entityId: 快照.id,
      summary: `撤销删除：${await 客户名(快照.customerId)}的一条${类型名(快照.type)}跟进回来了`,
    });
    revalidatePath(`/customers/${快照.customerId}`);
    revalidatePath("/follow-ups");
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
}

/* ---------------- 待办任务 ---------------- */

export async function saveTask(input: {
  id?: string;
  customerId: string;
  title: string;
  dueAt?: string | null;
  /** 编辑框打开那一刻的 updatedAt，版本闸门（同 FollowUpInput.版本，J-105） */
  版本?: string | null;
}) {
  try {
    const user = await requireUser();
  // 名字只有空格不收（第二轮 r2-data：原来存出一条没有名字的）
  if (!String(input.title ?? "").trim()) return { ok: false as const, error: "请填写待办内容" };
    const data = {
      title: input.title.trim(),
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      customerId: input.customerId,
    };
    // 同跟进记录：编辑别人的待办不该把负责人改成自己
    const 姓名 = await 客户名(input.customerId);
    if (input.id) {
      // 版本闸门（J-105）。0 行：要么这条删了，要么打开之后又变过了——分开说
      const 写了 = await prisma.task.updateMany({ where: { id: input.id, ...版本条件(input.版本) }, data: { ...data, ...推进版本(input.版本) } });
      if (写了.count === 0) {
        const 还在 = await prisma.task.findUnique({ where: { id: input.id }, select: { id: true } });
        return { ok: false as const, error: 还在 ? 版本冲突 : "这条待办已经不在了（可能在别处删了），刷新看看" };
      }
      await recordAudit({ user, action: "update", entity: "Task", entityId: input.id, summary: `修改${姓名}的待办「${data.title}」`, detail: data });
    } else {
      const t = await prisma.task.create({ data: { ...data, ownerId: user.id } });
      await recordAudit({ user, action: "create", entity: "Task", entityId: t.id, summary: `给${姓名}加了待办「${data.title}」`, detail: data });
    }
  
    刷新待办(input.customerId);
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
}

export async function toggleTask(id: string, done: boolean) {
  try {
    const me = await requireUser();
    const t = await prisma.task.update({
      where: { id },
      data: { done, doneAt: done ? new Date() : null },
    });
    await recordAudit({
      user: me, action: "update", entity: "Task", entityId: id,
      summary: `待办「${t.title}」标记为${done ? "已完成" : "未完成"}`,
    });
    刷新待办(t.customerId);
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
}

export async function deleteTask(id: string) {
  try {
    const me = await requireUser();
    const t = await prisma.task.delete({ where: { id } });
    await recordAudit({
      user: me, action: "delete", entity: "Task", entityId: id,
      summary: `删除${await 客户名(t.customerId)}的待办「${t.title}」`,
      detail: { 标题: t.title, 截止: t.dueAt ? dayjs(t.dueAt).format("YYYY-MM-DD") : null, 已完成: t.done },
    });
    刷新待办(t.customerId);
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
}

/* ---------------- 下次跟进计划 ---------------- */

export async function savePlan(input: {
  id?: string;
  customerId: string;
  subject: string;
  plannedAt: string;
  method: string;
  /** 编辑框打开那一刻的 updatedAt，版本闸门（同 FollowUpInput.版本，J-105） */
  版本?: string | null;
}) {
  try {
    const user = await requireUser();
  // 名字只有空格不收（第二轮 r2-data：原来存出一条没有名字的）
  if (!String(input.subject ?? "").trim()) return { ok: false as const, error: "请填写跟进主题" };
    const data = {
      subject: input.subject.trim(),
      plannedAt: new Date(input.plannedAt),
      method: input.method,
      customerId: input.customerId,
    };
    const 姓名 = await 客户名(input.customerId);
    const 说 = `${dayjs(data.plannedAt).format("YYYY-MM-DD")} ${data.method}·${data.subject}`;
    /*
      不带 id 永远是**另加一条**，不会顶掉这位已有的计划（一位客户可以同时欠着几条，
      记录页只摆最早那条）。计划页上就地新建时，框里照这个口径说「这条另加，不替换它」
    */
    let id = input.id ?? "";
    if (input.id) {
      // 版本闸门（J-105）。0 行：要么这条删了，要么打开之后又变过了（包括在别处点了「完成」）——分开说
      const 写了 = await prisma.followPlan.updateMany({ where: { id: input.id, ...版本条件(input.版本) }, data: { ...data, ...推进版本(input.版本) } });
      if (写了.count === 0) {
        const 还在 = await prisma.followPlan.findUnique({ where: { id: input.id }, select: { id: true } });
        return { ok: false as const, error: 还在 ? 版本冲突 : "这条计划已经不在了（可能在别处删了），刷新看看" };
      }
      await recordAudit({ user, action: "update", entity: "FollowPlan", entityId: input.id, summary: `修改${姓名}的跟进计划（${说}）`, detail: data });
    } else {
      const pl = await prisma.followPlan.create({ data: { ...data, ownerId: user.id } });
      id = pl.id;
      await recordAudit({ user, action: "create", entity: "FollowPlan", entityId: pl.id, summary: `给${姓名}排了跟进计划（${说}）`, detail: data });
    }
  
    revalidatePath(`/customers/${input.customerId}`);
    revalidatePath("/follow-ups/plans");
    // 带回 id：计划页新建完要把那一行点亮（和 saveFollowUp 一样）
    return { ok: true as const, id };
  } catch (e) {
    return 不在了(e);
  }
}

/**
 * 删一条计划（2026-10-02 排查 3-4）。原来计划在哪儿都删不掉：排错了、客户说不用了，只能一直挂在逾期里，
 * 每天早报还数它。和删待办同一个口径：就地确认、留痕。
 */
export async function deletePlan(id: string) {
  try {
    const me = await requireUser();
    const p = await prisma.followPlan.findUnique({ where: { id } });
    if (!p) return { ok: false as const, error: "这条计划已经不在了，刷新看看" };
    await prisma.followPlan.delete({ where: { id } });
    await recordAudit({
      user: me, action: "delete", entity: "FollowPlan", entityId: id,
      summary: `删除${await 客户名(p.customerId)}的跟进计划「${p.subject}」`,
      detail: { 主题: p.subject, 时间: dayjs(p.plannedAt).format("YYYY-MM-DD HH:mm"), 方式: p.method, 已完成: p.done },
    });
    revalidatePath(`/customers/${p.customerId}`);
    revalidatePath("/follow-ups/plans");
    revalidatePath("/dashboard");
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
}

/** 完成一条计划。`完成 = false` 是撤销（审查 M10）：提示条里那个「撤销」走这里，改回未完成 */
export async function completePlan(id: string, 完成 = true) {
  try {
    const me = await requireUser();
    const p = await prisma.followPlan.update({ where: { id }, data: { done: 完成 } });
    await recordAudit({
      user: me, action: "update", entity: "FollowPlan", entityId: id,
      summary: 完成
        ? `完成跟进计划「${p.subject}」（${await 客户名(p.customerId)}）`
        : `撤销完成跟进计划「${p.subject}」（${await 客户名(p.customerId)}）`,
    });
    revalidatePath(`/customers/${p.customerId}`);
    revalidatePath("/follow-ups/plans");
    revalidatePath("/dashboard");
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
}

/* ---------------- 联系人 ---------------- */

/**
 * 「主要联系人」全客户只能有一个。
 * 原本只是照着表单写 isPrimary，谁都能把自己那条勾成主要，
 * 两个人各自勾一条就会同时存在两个主要联系人；详情页按 isPrimary 倒序取第一条，
 * 显示哪一个取决于创建顺序，看上去像是对方的修改没生效。
 */
async function 只留这一个关键(tx: Prisma.TransactionClient, customerId: string, id: string) {
  await tx.contact.updateMany({
    where: { customerId, id: { not: id }, isPrimary: true },
    data: { isPrimary: false },
  });
}

function 刷新联系人(customerId?: string | null) {
  if (customerId) revalidatePath(`/customers/${customerId}`);
  revalidatePath("/contacts");
}

type 联系人字段 = {
  name: string;
  position?: string | null;
  phone?: string | null;
  email?: string | null;
  wechat?: string | null;
  remark?: string | null;
};

/**
 * 联系人的电话：共享区表单交回的是打码的样子，认回原号（排查 A2）；认不回来又带 * 的不收。
 * 联系人电话一直不做格式校验（座机、分机、「找前台转」都有人写），这里只拦打码那一种。
 */
function 联系人电话(交回: string | null | undefined, 原: string | null | undefined): { ok: true; phone: string | null } | { ok: false; error: string } {
  const v = String(认回打码号(交回, 原) ?? "").trim();
  if (v.includes("*")) return { ok: false, error: "电话里不能有 *" };
  return { ok: true, phone: v || null };
}

function 规整(input: 联系人字段) {
  return {
    name: input.name.trim(),
    position: input.position || null,
    phone: input.phone || null,
    email: input.email || null,
    wechat: input.wechat || null,
    remark: input.remark || null,
  };
}

export async function saveContact(input: 联系人字段 & { id?: string; customerId: string; isPrimary: boolean; 版本?: string | null }) {
  try {
    const me = await requireUser();
  // 名字只有空格不收（第二轮 r2-data：原来存出一条没有名字的）
  if (!String(input.name ?? "").trim()) return { ok: false as const, error: "请填写联系人姓名" };
    const 原 = input.id ? await prisma.contact.findUnique({ where: { id: input.id }, select: { phone: true } }) : null;
    if (input.id && !原) return { ok: false as const, error: "这位联系人已经不在这儿了，刷新看看" };
    const 电话 = 联系人电话(input.phone, 原?.phone);
    if (!电话.ok) return 电话;
    const data = { ...规整(input), phone: 电话.phone, isPrimary: input.isPrimary, customerId: input.customerId };
    const 落库id = await prisma.$transaction(async (tx) => {
      // 编辑走版本闸门（排查 D3）：期间有人改过就一行不写
      if (input.id) {
        const 写了 = await tx.contact.updateMany({ where: { id: input.id, ...版本条件(input.版本) }, data });
        if (写了.count === 0) return null;
      }
      const savedId = input.id ?? (await tx.contact.create({ data })).id;
      if (input.isPrimary) await 只留这一个关键(tx, input.customerId, savedId);
      return savedId;
    });
    if (!落库id) return { ok: false as const, error: 版本冲突 };
    await recordAudit({
      user: me, action: input.id ? "update" : "create", entity: "Contact", entityId: 落库id,
      summary: `${input.id ? "修改" : "新建"}${await 客户名(input.customerId)}的联系人「${data.name}」${input.isPrimary ? "（主要联系人）" : ""}`,
      detail: { 姓名: data.name, 职位: data.position, 电话: data.phone, 微信: data.wechat, 主要联系人: data.isPrimary },
    });
  
    刷新联系人(input.customerId);
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
}

/* ---------- 未归属：从客户上移出、人留着（2026-10-01 用户反馈） ---------- */

/**
 * 把一位未归属的人挂到某位客户下面：Contact 里按原 id 建回来，UnassignedContact 那行删掉。
 * 挂回的正是原来那位时，原来指着他的跟进记录也接回去（只接这会儿还空着的——
 * 移出之后有人在那条跟进上另挑了联系人，就不抢回来）。挂到别人下面时不接：那几条是原来那位的跟进。
 */
async function 挂上(
  tx: Prisma.TransactionClient,
  u: { id: string; fromCustomerId: string | null; followUpIds: string | null; createdAt: Date } & ReturnType<typeof 规整>,
  customerId: string,
  isPrimary: boolean,
) {
  await tx.contact.create({
    data: {
      id: u.id, name: u.name, position: u.position, phone: u.phone, email: u.email, wechat: u.wechat, remark: u.remark,
      isPrimary, customerId, createdAt: u.createdAt,
    },
  });
  if (isPrimary) await 只留这一个关键(tx, customerId, u.id);
  const 跟进 = u.fromCustomerId === customerId ? (JSON.parse(u.followUpIds ?? "[]") as string[]) : [];
  if (跟进.length) {
    await tx.followUp.updateMany({ where: { id: { in: 跟进 }, customerId, contactId: null }, data: { contactId: u.id } });
  }
  await tx.unassignedContact.delete({ where: { id: u.id } });
}

/**
 * 只从这位客户上移出，人留着：联系人页里写「未归属」，以后能挂到哪一位下面。
 * 回的 `原来是关键` 给撤销用。
 */
export async function detachContact(id: string) {
  try {
    const me = await requireUser();
    const c = await prisma.contact.findUnique({ where: { id }, include: { customer: { select: { name: true } } } });
    if (!c) return { ok: false as const, error: "这位联系人已经不在这儿了，刷新看看" };
    const 跟进 = await prisma.followUp.findMany({ where: { contactId: id }, select: { id: true } });
    // 函数式事务：数组式在托管版的工作区代理下会抛错（见 lib/carry-over-db.ts 带走没做完的）
    await prisma.$transaction(async (tx) => {
      await tx.unassignedContact.create({
        data: {
          id: c.id, name: c.name, position: c.position, phone: c.phone, email: c.email, wechat: c.wechat, remark: c.remark,
          fromCustomerId: c.customerId, fromCustomerName: c.customer.name,
          followUpIds: 跟进.length ? JSON.stringify(跟进.map((f) => f.id)) : null,
          createdAt: c.createdAt,
        },
      });
      // 原来那条删掉。跟进记录上的 contactId 由外键置空，id 记在上面那行里，挂回来时接上
      await tx.contact.delete({ where: { id } });
    });
    await recordAudit({
      user: me, action: "update", entity: "Contact", entityId: id,
      summary: `把联系人「${c.name}」从${c.customer.name}移出（联系人页里还留着）`,
      detail: { 姓名: c.name },
    });
    刷新联系人(c.customerId);
    return { ok: true as const, 原来是关键: c.isPrimary };
  } catch (e) {
    return 不在了(e);
  }
}

/** 撤销移出：挂回原来那位，关键联系人原样回去 */
export async function undoDetachContact(id: string, 原来是关键: boolean) {
  try {
    const me = await requireUser();
    const u = await prisma.unassignedContact.findUnique({ where: { id } });
    if (!u) return { ok: true as const };
    if (!u.fromCustomerId || !(await prisma.customer.findUnique({ where: { id: u.fromCustomerId }, select: { id: true } }))) {
      return { ok: false as const, error: "原来那位客户已经不在了，撤不回去" };
    }
    await prisma.$transaction((tx) => 挂上(tx, u, u.fromCustomerId!, 原来是关键));
    await recordAudit({
      user: me, action: "update", entity: "Contact", entityId: id,
      summary: `撤销移出：联系人「${u.name}」回到${u.fromCustomerName ?? "原来那位"}`,
      detail: { 姓名: u.name },
    });
    刷新联系人(u.fromCustomerId);
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
}

/**
 * 联系人页上改一位未归属的人。给了 `customerId` 就是挂到那位下面，不给就还留在未归属、只改资料。
 */
export async function saveUnassignedContact(input: 联系人字段 & { id: string; customerId?: string | null; isPrimary?: boolean; 版本?: string | null }) {
  try {
    const me = await requireUser();
    const u = await prisma.unassignedContact.findUnique({ where: { id: input.id } });
    if (!u) return { ok: false as const, error: "这位联系人已经不在了，刷新看看" };
    // 版本闸门（排查 D3）：打开编辑框之后有人改过（或已经被别人挂走），不盖掉
    if (input.版本 && 版本条件(input.版本).updatedAt?.getTime() !== u.updatedAt.getTime()) return { ok: false as const, error: 版本冲突 };
    const 电话 = 联系人电话(input.phone, u.phone);
    if (!电话.ok) return 电话;
    const data = { ...规整(input), phone: 电话.phone };
    if (input.customerId) {
      const 客户 = await prisma.customer.findUnique({ where: { id: input.customerId }, select: { name: true } });
      if (!客户) return { ok: false as const, error: "那位客户已经不在了，换一位" };
      await prisma.$transaction((tx) => 挂上(tx, { ...u, ...data }, input.customerId!, Boolean(input.isPrimary)));
      await recordAudit({
        user: me, action: "update", entity: "Contact", entityId: u.id,
        summary: `把未归属的联系人「${data.name}」挂到${客户.name}`,
        detail: { 姓名: data.name, 职位: data.position, 电话: data.phone, 微信: data.wechat },
      });
      刷新联系人(input.customerId);
      return { ok: true as const, 挂到: 客户.name };
    }
    await prisma.unassignedContact.update({ where: { id: u.id }, data });
    await recordAudit({
      user: me, action: "update", entity: "Contact", entityId: u.id,
      summary: `修改未归属的联系人「${data.name}」`,
      detail: { 姓名: data.name, 职位: data.position, 电话: data.phone, 微信: data.wechat },
    });
    刷新联系人();
    return { ok: true as const, 挂到: null };
  } catch (e) {
    return 不在了(e);
  }
}

/* ---------- 彻底删除 + 撤销 ---------- */

/** 彻底删掉之后撤销要用的：原样的那一行（挂着的或未归属的），加上原来指着他的跟进记录 */
export type 删掉的联系人 =
  | {
      哪种: "挂着";
      id: string; name: string; position: string | null; phone: string | null; email: string | null;
      wechat: string | null; remark: string | null; isPrimary: boolean; customerId: string; createdAt: string;
      跟进: string[];
    }
  | {
      哪种: "未归属";
      id: string; name: string; position: string | null; phone: string | null; email: string | null;
      wechat: string | null; remark: string | null; fromCustomerId: string | null; fromCustomerName: string | null;
      followUpIds: string | null; detachedAt: string; createdAt: string;
    };

/** 彻底删除：联系人页里也没了。他名下的跟进记录留着，只是不再写「跟谁谈的」 */
export async function deleteContact(id: string) {
  try {
    const me = await requireUser();
    // 别人刚删了 / 刚移出了：说一句，不抛（原来抛出去，界面上什么反应都没有）
    if (!(await prisma.contact.findUnique({ where: { id }, select: { id: true } }))) {
      return { ok: false as const, error: "这位联系人已经不在这儿了，刷新看看" };
    }
    const 跟进 = await prisma.followUp.findMany({ where: { contactId: id }, select: { id: true } });
    const c = await prisma.contact.delete({ where: { id } });
    await recordAudit({
      user: me, action: "delete", entity: "Contact", entityId: id,
      summary: `删除${await 客户名(c.customerId)}的联系人「${c.name}」`,
      detail: { 姓名: c.name, 职位: c.position, 电话: c.phone },
    });
    刷新联系人(c.customerId);
    const 快照: 删掉的联系人 = {
      哪种: "挂着",
      id: c.id, name: c.name, position: c.position, phone: c.phone, email: c.email, wechat: c.wechat, remark: c.remark,
      isPrimary: c.isPrimary, customerId: c.customerId, createdAt: c.createdAt.toISOString(),
      跟进: 跟进.map((f) => f.id),
    };
    return { ok: true as const, 快照 };
  } catch (e) {
    return 不在了(e);
  }
}

/** 联系人页上彻底删一位未归属的人 */
export async function deleteUnassignedContact(id: string) {
  try {
    const me = await requireUser();
    if (!(await prisma.unassignedContact.findUnique({ where: { id }, select: { id: true } }))) {
      return { ok: false as const, error: "这位联系人已经不在了，刷新看看" };
    }
    const u = await prisma.unassignedContact.delete({ where: { id } });
    await recordAudit({
      user: me, action: "delete", entity: "Contact", entityId: id,
      summary: `删除未归属的联系人「${u.name}」`,
      detail: { 姓名: u.name, 职位: u.position, 电话: u.phone },
    });
    刷新联系人();
    const 快照: 删掉的联系人 = {
      哪种: "未归属",
      id: u.id, name: u.name, position: u.position, phone: u.phone, email: u.email, wechat: u.wechat, remark: u.remark,
      fromCustomerId: u.fromCustomerId, fromCustomerName: u.fromCustomerName, followUpIds: u.followUpIds,
      detachedAt: u.detachedAt.toISOString(), createdAt: u.createdAt.toISOString(),
    };
    return { ok: true as const, 快照 };
  } catch (e) {
    return 不在了(e);
  }
}

/** 撤销删除：同一个 id 原样建回来；挂着的那种连原来的跟进记录一起接回去 */
export async function restoreContact(快照: 删掉的联系人) {
  try {
    const me = await requireUser();
    const 在 = await Promise.all([
      prisma.contact.findUnique({ where: { id: 快照.id }, select: { id: true } }),
      prisma.unassignedContact.findUnique({ where: { id: 快照.id }, select: { id: true } }),
    ]);
    if (在[0] || 在[1]) return { ok: true as const };
    if (快照.哪种 === "未归属") {
      await prisma.unassignedContact.create({
        data: {
          id: 快照.id, name: 快照.name, position: 快照.position, phone: 快照.phone, email: 快照.email, wechat: 快照.wechat,
          remark: 快照.remark, fromCustomerId: 快照.fromCustomerId, fromCustomerName: 快照.fromCustomerName,
          followUpIds: 快照.followUpIds, detachedAt: new Date(快照.detachedAt), createdAt: new Date(快照.createdAt),
        },
      });
    } else {
      if (!(await prisma.customer.findUnique({ where: { id: 快照.customerId }, select: { id: true } }))) {
        return { ok: false as const, error: "原来那位客户已经不在了，撤不回来" };
      }
      await prisma.$transaction(async (tx) => {
        await tx.contact.create({
          data: {
            id: 快照.id, name: 快照.name, position: 快照.position, phone: 快照.phone, email: 快照.email, wechat: 快照.wechat,
            remark: 快照.remark, isPrimary: 快照.isPrimary, customerId: 快照.customerId, createdAt: new Date(快照.createdAt),
          },
        });
        if (快照.isPrimary) await 只留这一个关键(tx, 快照.customerId, 快照.id);
        if (快照.跟进.length) {
          await tx.followUp.updateMany({
            where: { id: { in: 快照.跟进 }, customerId: 快照.customerId, contactId: null },
            data: { contactId: 快照.id },
          });
        }
      });
    }
    await recordAudit({
      user: me, action: "create", entity: "Contact", entityId: 快照.id,
      summary: `撤销删除：联系人「${快照.name}」回来了`,
      detail: { 姓名: 快照.name },
    });
    刷新联系人(快照.哪种 === "挂着" ? 快照.customerId : null);
    return { ok: true as const };
  } catch (e) {
    return 不在了(e);
  }
}
