"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";

/**
 * 首页对话的历史：列、新建、读、落一轮、重命名、删。
 *
 * **每一个函数都按 ownerId 过滤，一个都不能漏。** 桌面端的库本来就在本人机器上，
 * 但托管版一个工作区里有好几个人——问 AI 的过程常常带着还没想清楚的判断，
 * 和「全员可见可改」的业务数据不是一回事。所以这里不给管理员开后门，也不做「谁都能看」。
 *
 * 落库的是**答完的那一轮**：问题、回答正文、用时、模型、工具调用轨迹、涉及到的记录 id。
 * 不落的是提问带的附件原文——它只活在内存里（components/AskFiles.tsx），
 * 入了库就等于进了备份，那是另一个量级的承诺。
 */

export type 对话概要 = {
  id: string;
  title: string;
  lastAskedAt: string;
  pinnedAt: string | null;
  /** 有几轮问答。列表上不显示，用来判断「这条是空的」 */
  条数: number;
};

export type 历史消息 = {
  id: string;
  role: "user" | "assistant";
  text: string;
  model: string | null;
  ms: number | null;
  steps: unknown;
  refs: unknown;
  createdAt: string;
};

/** 标题取第一问的前 18 个字，和侧栏「AI 任务」那条的口径一致 */
function 取标题(问题: string): string {
  const t = 问题.trim().replace(/\s+/g, " ");
  return t.length > 18 ? `${t.slice(0, 18)}…` : t || "新对话";
}

function 解析(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    // 存坏了就当没有：翻历史时少一行轨迹，总好过整页打不开
    return null;
  }
}

export async function 列对话(): Promise<对话概要[]> {
  const me = await requireUser();
  const rows = await prisma.aiConversation.findMany({
    where: { ownerId: me.id, archivedAt: null },
    orderBy: [{ pinnedAt: "desc" }, { lastAskedAt: "desc" }],
    take: 200,
    select: { id: true, title: true, lastAskedAt: true, pinnedAt: true, _count: { select: { messages: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    lastAskedAt: r.lastAskedAt.toISOString(),
    pinnedAt: r.pinnedAt?.toISOString() ?? null,
    条数: r._count.messages,
  }));
}

export async function 读对话(id: string): Promise<{ id: string; title: string; messages: 历史消息[] } | null> {
  const me = await requireUser();
  const c = await prisma.aiConversation.findFirst({
    where: { id, ownerId: me.id },
    select: {
      id: true,
      title: true,
      messages: { orderBy: { createdAt: "asc" }, take: 200 },
    },
  });
  if (!c) return null;
  return {
    id: c.id,
    title: c.title,
    messages: c.messages.map((m) => ({
      id: m.id,
      role: m.role === "user" ? "user" : "assistant",
      text: m.text,
      model: m.model,
      ms: m.ms,
      steps: 解析(m.steps),
      refs: 解析(m.refs),
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

export async function 新建对话(标题 = "新对话"): Promise<{ id: string }> {
  const me = await requireUser();
  const c = await prisma.aiConversation.create({
    data: { title: 取标题(标题), ownerId: me.id },
    select: { id: true },
  });
  return c;
}

/**
 * 答完一轮，落库。
 *
 * 没给 conversationId（或者给的那条不是自己的）就新开一条，标题取这一问——
 * 首页那个输入框永远能直接问，不该逼人先「新建对话」。
 * 返回落到了哪条，调用方据此把地址栏的 ?c= 对上。
 */
export async function 落一轮(input: {
  conversationId?: string | null;
  question: string;
  answer: string;
  model?: string | null;
  ms?: number | null;
  steps?: unknown;
  refs?: unknown;
}): Promise<{ conversationId: string }> {
  const me = await requireUser();

  let id = input.conversationId ?? null;
  if (id) {
    const 有 = await prisma.aiConversation.count({ where: { id, ownerId: me.id } });
    if (!有) id = null;
  }
  if (!id) id = (await 新建对话(input.question)).id;

  const 串 = (v: unknown) => (v == null ? null : JSON.stringify(v));
  await prisma.$transaction([
    prisma.aiMessage.create({ data: { conversationId: id, role: "user", text: input.question } }),
    prisma.aiMessage.create({
      data: {
        conversationId: id,
        role: "assistant",
        text: input.answer,
        model: input.model ?? null,
        ms: input.ms ?? null,
        steps: 串(input.steps),
        refs: 串(input.refs),
      },
    }),
    prisma.aiConversation.update({ where: { id }, data: { lastAskedAt: new Date() } }),
  ]);
  return { conversationId: id };
}

export async function 重命名对话(id: string, 标题: string): Promise<{ ok: boolean }> {
  const me = await requireUser();
  const t = 标题.trim().slice(0, 60);
  if (!t) return { ok: false };
  const r = await prisma.aiConversation.updateMany({ where: { id, ownerId: me.id }, data: { title: t } });
  return { ok: r.count > 0 };
}

/**
 * 删一条对话。消息跟着级联删。
 *
 * 真删，不是归档：这是自己的对话，人说删就是删。**不记操作日志**——
 * 那张表是给团队追溯业务改动的，而这里没有别人要追溯的东西。
 */
export async function 删除对话(id: string): Promise<{ ok: boolean }> {
  const me = await requireUser();
  const r = await prisma.aiConversation.deleteMany({ where: { id, ownerId: me.id } });
  return { ok: r.count > 0 };
}
