import { control } from "./tenant/control";
import type { 我的一条反馈, 串里一条 } from "./feedback-unread";

/**
 * 一条反馈下面的一整串往来（2026-10-19，control-migrations/027）。**云端这一份**。
 *
 * 原来运营台的回复只走邮件（FeedbackReply），没配 SMTP、或者对方是手机号注册的，回复就到不了人手里。
 * 现在我们的回复进应用：桌面端定时来问「我的反馈」，拿到的就是这里拼出来的串。
 *
 * 一串 = 原话 + FeedbackReply 里那几封老邮件（当作我们回的）+ FeedbackMessage（新回复、用户接着说），按时间排。
 * 给用户看的那份不带运营是谁、邮件发到了哪——那是我们这边的事；运营台那份带。
 */

/** 用户「接着说」的上限：和第一条反馈一样 */
export const 接着说上限 = 4000;

/** 一次最多回这么多条反馈。桌面端每几分钟问一次，不能越攒越重 */
const 最多几条 = 100;

export type 运营台串里一条 = 串里一条 & { by: string | null; 邮件: { to: string; ok: boolean } | null };

/** 把这几条反馈的往来按时间拼好。运营台和「我的反馈」共用，只是给用户那份把 by / 邮件去掉 */
export async function 读串(feedbackIds: string[]): Promise<Map<string, 运营台串里一条[]>> {
  const 出 = new Map<string, 运营台串里一条[]>(feedbackIds.map((id) => [id, []]));
  if (!feedbackIds.length) return 出;
  const [老邮件, 新的] = await Promise.all([
    control.feedbackReply.findMany({ where: { feedbackId: { in: feedbackIds } } }),
    control.feedbackMessage.findMany({ where: { feedbackId: { in: feedbackIds } } }),
  ]);
  for (const r of 老邮件) {
    出.get(r.feedbackId)?.push({ id: `r_${r.id}`, at: r.at.toISOString(), 谁: "团队", body: r.body, by: r.by, 邮件: { to: r.to, ok: true } });
  }
  for (const m of 新的) {
    出.get(m.feedbackId)?.push({
      id: m.id,
      at: m.at.toISOString(),
      谁: m.side === "user" ? "我" : "团队",
      body: m.body,
      by: m.by,
      邮件: m.emailTo ? { to: m.emailTo, ok: m.emailOk === true } : null,
    });
  }
  // 同一毫秒落的两条（测试里常见）按 id 定个先后，两边每次排出来一样
  for (const 串 of 出.values()) 串.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return 出;
}

/** 这个账号发过的反馈，每条带着往来。**只按 accountId 查**：令牌认出是谁，别人的一条都不回 */
export async function 我的反馈(accountId: string): Promise<我的一条反馈[]> {
  const 行 = await control.feedback.findMany({ where: { accountId }, orderBy: { at: "desc" }, take: 最多几条 });
  const 串们 = await 读串(行.map((f) => f.id));
  return 行.map((f) => ({
    id: f.id,
    at: f.at.toISOString(),
    body: f.body,
    消息: (串们.get(f.id) ?? []).map(({ id, at, 谁, body }) => ({ id, at, 谁, body })),
  }));
}

export type 接着说结果 = { ok: true; 消息: 串里一条 } | { ok: false; status: 400 | 404; error: string };

/**
 * 用户在应用里接着说：挂在他自己那条反馈下面，那条反馈重新算「没处理」——运营台的红数会把它顶回来。
 * 不是他的（或者不存在）一律 404，不区分：不给人拿反馈 id 去试别人的。
 * 同一个 clientKey 再来一次（上次发出去了但回音没到）：回上次那条，不落第二行。
 */
export async function 接着说(input: { accountId: string; feedbackId: string; body: string; clientKey?: string | null }): Promise<接着说结果> {
  const body = (input.body ?? "").trim();
  if (!body) return { ok: false, status: 400, error: "写一句再发" };
  if (body.length > 接着说上限) return { ok: false, status: 400, error: `太长了，${接着说上限} 字以内` };
  const f = await control.feedback.findUnique({ where: { id: input.feedbackId } });
  if (!f || f.accountId !== input.accountId) return { ok: false, status: 404, error: "没有这条反馈" };

  const clientKey = (input.clientKey ?? "").trim().slice(0, 64) || null;
  if (clientKey) {
    const 有过 = await control.feedbackMessage.findFirst({ where: { feedbackId: f.id, clientKey } });
    if (有过) return { ok: true, 消息: { id: 有过.id, at: 有过.at.toISOString(), 谁: "我", body: 有过.body } };
  }
  const [m] = await control.$transaction([
    control.feedbackMessage.create({ data: { feedbackId: f.id, side: "user", body, clientKey } }),
    control.feedback.update({ where: { id: f.id }, data: { handled: false } }),
  ]);
  return { ok: true, 消息: { id: m.id, at: m.at.toISOString(), 谁: "我", body: m.body } };
}
