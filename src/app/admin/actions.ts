"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { 口令对 } from "./guard";
import { 当前运营账号 } from "@/lib/ops-auth";
import { control } from "@/lib/tenant/control";
import { multiTenant } from "@/lib/tenant/context";
import { isPlanKey, PLANS } from "@/lib/tenant/plans";
import { createWorkspace } from "@/lib/tenant/workspaces";
import { createAccount, findAccountByTarget, parseTarget } from "@/lib/tenant/accounts";
import { 加次数 } from "@/lib/tenant/ai-allowance";
import { 查回复, 回复通道可用, 组回复邮件, 回信地址, 发回复 } from "@/lib/feedback-reply";

export type AdminResult = { ok: true } | { ok: false; error: string };

/**
 * 运营台的动作。
 *
 * 每个动作都要重新验 token：Server Action 是独立的 HTTP 端点，页面那次校验
 * 拦不住直接调用它的人。「页面进得来所以动作能调」是最常见的一类越权。
 */
async function guard(token: string): Promise<AdminResult> {
  if (!multiTenant()) return { ok: false, error: "无权操作" };
  if (口令对(token)) return { ok: true };
  // 从桌面端进来的没有口令，认运营台票（见 lib/ops-auth.ts）
  if (await 当前运营账号()) return { ok: true };
  return { ok: false, error: "无权操作" };
}

/** 手动开通：按套餐从今天或现有到期日往后顺延 */
export async function activate(input: { token: string; workspaceId: string; plan: string; note?: string }): Promise<AdminResult> {
  const g = await guard(input.token);
  if (!g.ok) return g;
  if (!isPlanKey(input.plan)) return { ok: false, error: "套餐不对" };

  const ws = await control.workspace.findUnique({ where: { id: input.workspaceId } });
  if (!ws) return { ok: false, error: "工作区不存在" };

  // 续费要在原到期日基础上顺延，不能从今天重算——那会把用户已付的天数吃掉
  const base = ws.paidUntil && ws.paidUntil > new Date() ? ws.paidUntil : new Date();
  const paidUntil = new Date(base.getTime() + PLANS[input.plan].days * 86_400_000);
  const 记录 = `[已开通] ${new Date().toISOString().slice(0, 10)} ${PLANS[input.plan].label} 至 ${paidUntil.toISOString().slice(0, 10)}${input.note ? ` ${input.note}` : ""}`;

  await control.workspace.update({
    where: { id: input.workspaceId },
    data: { status: "ACTIVE", paidUntil, note: ws.note ? `${ws.note}\n${记录}` : 记录 },
  });
  revalidatePath("/admin", "layout");
  return { ok: true };
}

/** 运营者是谁：运营账号的邮箱 / 手机；用网址口令进来的记「口令」。留在操作记录里 */
async function 运营者(): Promise<string> {
  const 运营 = await 当前运营账号();
  const a = 运营 ? await control.account.findUnique({ where: { id: 运营 }, select: { email: true, phone: true } }) : null;
  return a?.email ?? a?.phone ?? "口令";
}

/**
 * 团队同步：开通 / 续费（2026-10-15 按时长）。选时长（1 / 3 / 6 / 12 个月，或试用几天）和人数，
 * 还没到期从原到期日顺延，已过期或从没开通从今天算（lib/tenant/team-plan.ts）。amount：实收（元），null = 没收钱
 */
export async function 开通续费团队(input: { token: string; teamId: string; months?: number; days?: number; seats: number; amount: number | null; note?: string }): Promise<AdminResult & { paidUntil?: string | null }> {
  const g = await guard(input.token);
  if (!g.ok) return g;
  const { 开通续费, 北京日期 } = await import("@/lib/tenant/team-plan");
  const 时长 = input.days ? { days: Number(input.days) } : { months: Number(input.months) };
  const r = await 开通续费({ teamId: String(input.teamId), 时长, seats: Number(input.seats), amount: input.amount === null ? null : Number(input.amount), note: input.note, by: await 运营者() });
  if (!r.ok) return r;
  revalidatePath("/admin", "layout");
  return { ok: true, paidUntil: r.paidUntil ? 北京日期(r.paidUntil) : null };
}

/** 手动改到期日（纠错用）。date：「YYYY-MM-DD」（北京时间那天结束），null = 不限期 */
export async function 改团队到期(input: { token: string; teamId: string; date: string | null; note?: string }): Promise<AdminResult> {
  const g = await guard(input.token);
  if (!g.ok) return g;
  const { 改到期, 解析日期 } = await import("@/lib/tenant/team-plan");
  const d = input.date === null ? null : 解析日期(String(input.date));
  if (input.date !== null && !d) return { ok: false, error: "日期不对" };
  const r = await 改到期({ teamId: String(input.teamId), paidUntil: d, note: input.note, by: await 运营者() });
  if (!r.ok) return r;
  revalidatePath("/admin", "layout");
  return { ok: true };
}

/** 只改人数上限（2026-10-19）：客户要加人 / 减人时改，不动到期日、不收钱；下一次入队、批准设备马上按新数拦 */
export async function 改团队人数(input: { token: string; teamId: string; seats: number; note?: string }): Promise<AdminResult> {
  const g = await guard(input.token);
  if (!g.ok) return g;
  const { 改人数 } = await import("@/lib/tenant/team-plan");
  const r = await 改人数({ teamId: String(input.teamId), seats: Number(input.seats), note: input.note, by: await 运营者() });
  if (!r.ok) return r;
  revalidatePath("/admin", "layout");
  return { ok: true };
}

/** 团队同步：停用（2026-10-03）。成员推拉都回「还没开通」，本机数据不受影响；到期日不动，之后续费照常顺延 */
export async function 停用团队(input: { token: string; teamId: string; note?: string }): Promise<AdminResult> {
  const g = await guard(input.token);
  if (!g.ok) return g;
  const { 停用 } = await import("@/lib/tenant/team-plan");
  const r = await 停用({ teamId: String(input.teamId), note: input.note, by: await 运营者() });
  if (!r.ok) return r;
  revalidatePath("/admin", "layout");
  return { ok: true };
}

/** 团队版价格表（每人）。改了桌面端「设置 → 团队」马上看到 */
export async function 改团队价格(input: { token: string; prices: { months: number; perSeat: number }[]; trialDays: number }): Promise<AdminResult> {
  const g = await guard(input.token);
  if (!g.ok) return g;
  const { 存价格 } = await import("@/lib/tenant/team-plan");
  const 错 = await 存价格({ prices: input.prices, trialDays: input.trialDays }, await 运营者());
  if (错) return { ok: false, error: 错 };
  revalidatePath("/admin", "layout");
  return { ok: true };
}

/** 延长试用：谈单过程中常用，比直接开通更轻 */
export async function extendTrial(input: { token: string; workspaceId: string; days: number }): Promise<AdminResult> {
  const g = await guard(input.token);
  if (!g.ok) return g;
  const days = Math.max(1, Math.min(90, Math.round(input.days)));

  const ws = await control.workspace.findUnique({ where: { id: input.workspaceId } });
  if (!ws) return { ok: false, error: "工作区不存在" };

  const base = ws.trialEndsAt > new Date() ? ws.trialEndsAt : new Date();
  await control.workspace.update({
    where: { id: input.workspaceId },
    data: { trialEndsAt: new Date(base.getTime() + days * 86_400_000), status: ws.status === "SUSPENDED" ? "TRIAL" : ws.status },
  });
  revalidatePath("/admin", "layout");
  return { ok: true };
}

/** 停用：滥用或欠费时用。数据不动，只是进不去 */
export async function suspend(input: { token: string; workspaceId: string; on: boolean }): Promise<AdminResult> {
  const g = await guard(input.token);
  if (!g.ok) return g;
  await control.workspace.update({
    where: { id: input.workspaceId },
    data: { status: input.on ? "SUSPENDED" : "TRIAL" },
  });
  revalidatePath("/admin", "layout");
  return { ok: true };
}

/** 开工作区的结果：成功时把初始密码带回来，只有这一次能看到 */
export type OpenResult =
  | { ok: true; slug: string; contact: string; password: string }
  | { ok: false; error: string };

/**
 * 手动开一个试用工作区。
 *
 * 存在的理由：自助注册下线之后，`createWorkspace` 就只剩这一个调用方了。
 * 客户从官网 demo.html 发邮件过来，聊完在这里建号，把账号密码复制进邮件回复。
 * 系统不主动发信——没有短信也没有邮件通道，这是现在唯一走得通的路。
 *
 * 初始密码由服务端生成而不是让运营的人自己想：人想出来的密码会重样，
 * 而这批密码是发给陌生人的，重样一次就是两个工作区共用一把钥匙。
 */
export async function openWorkspace(input: {
  token: string;
  workspace: string;
  name: string;
  target: string;
}): Promise<OpenResult> {
  const g = await guard(input.token);
  if (!g.ok) return g;

  const t = parseTarget(input.target);
  if (!t) return { ok: false, error: "手机号或邮箱格式不对" };
  if (!input.name.trim()) return { ok: false, error: "请填对方姓名" };
  if (!input.workspace.trim()) return { ok: false, error: "请填团队名称" };
  if (await findAccountByTarget(t.value)) return { ok: false, error: "这个号已经有账号了，去下面的列表找他的工作区" };

  // 12 位 base64url，够长到不用担心被猜；去掉容易看错的字符，因为它要被人手抄进登录框
  const password = randomBytes(12).toString("base64url").replace(/[-_lIO0]/g, "x").slice(0, 12);

  let account;
  try {
    account = await createAccount({ target: t, password, name: input.name });
  } catch {
    return { ok: false, error: "这个号已经有账号了" };
  }

  try {
    const ws = await createWorkspace({ name: input.workspace, account });
    revalidatePath("/admin", "layout");
    return { ok: true, slug: ws.slug, contact: t.value, password };
  } catch (e) {
    // 和注册那条路一样：工作区没开成，账号留着只会让这个号再也开不了
    await control.account.delete({ where: { id: account.id } }).catch(() => {});
    console.error("[admin] 开工作区失败：", e);
    return { ok: false, error: "开通失败，看服务器日志" };
  }
}

/** 给某个工作区手动加 AI 次数。谈单时想让对方多试几次 */
export async function grantAi(input: { token: string; workspaceId: string; amount: number; note?: string }): Promise<AdminResult> {
  const g = await guard(input.token);
  if (!g.ok) return g;
  await 加次数(input.workspaceId, input.amount, input.note ?? "运营台");
  revalidatePath("/admin", "layout");
  return { ok: true };
}

/**
 * 给一个桌面端账号手动加次数（2026-10-19 运营台「次数」页、团队详情页、用户详情页共用）。种类：research 背调次数 / ai 问答的 AI 次数。
 * 只加不减；一次 1–1000；key 是弹框打开时生成的点击编号，同一个 key 只加一次（连点、重发都不多加）；
 * 每次记一行 AdminCreditLog（谁加的）。规矩全在 lib/tenant/admin-credits.ts 的 运营加次
 */
export async function 给账号加次数(input: { token: string; accountId: string; 种类: "research" | "ai"; n: number; key: string; note?: string; teamId?: string }): Promise<AdminResult & { 重复?: boolean }> {
  const g = await guard(input.token);
  if (!g.ok) return g;
  const { 运营加次 } = await import("@/lib/tenant/admin-credits");
  const r = await 运营加次({
    accountId: String(input.accountId),
    种类: input.种类,
    n: Number(input.n),
    key: String(input.key ?? ""),
    note: typeof input.note === "string" ? input.note : null,
    teamId: input.teamId ? String(input.teamId) : null,
    by: await 运营者(),
  });
  if (!r.ok) return r;
  revalidatePath("/admin", "layout");
  return { ok: true, 重复: r.重复 };
}

/**
 * 标成 / 取消测试账号（2026-10-04，lib/tenant/test-accounts.ts）。测试账号 AI 不限次数、不算进运营台的统计、不触发运营通知。
 * 留痕：谁（运营账号的邮箱；用网址口令进来的记「口令」）、什么时候，追加在 TestAccount.log 里，取消也不删。
 * 运营账号（OPS_ACCOUNTS）本来就算测试账号，在这里取消只是去掉「标的」那一份，它仍然因为是运营账号而算。
 */
export async function 设测试账号(input: { token: string; accountId: string; on: boolean }): Promise<AdminResult> {
  const g = await guard(input.token);
  if (!g.ok) return g;
  const a = await control.account.findUnique({ where: { id: input.accountId }, select: { id: true } });
  if (!a) return { ok: false, error: "账号不存在" };
  const 运营 = await 当前运营账号();
  const 运营名 = 运营 ? ((await control.account.findUnique({ where: { id: 运营 }, select: { email: true, phone: true } })) ?? null) : null;
  const { 设测试账号: 设 } = await import("@/lib/tenant/test-accounts");
  await 设(a.id, Boolean(input.on), 运营名?.email ?? 运营名?.phone ?? "口令");
  revalidatePath("/admin", "layout");
  return { ok: true };
}

/**
 * 反馈标记处理过了（可以来回切）。
 * 不提供删除：一条反馈是有人花时间写的，读过就收起来，但不该被一个误点抹掉。
 */
export async function 标记反馈(input: { token: string; id: string; handled: boolean }): Promise<AdminResult> {
  const g = await guard(input.token);
  if (!g.ok) return g;
  await control.feedback.update({ where: { id: input.id }, data: { handled: input.handled } });
  revalidatePath("/admin", "layout");
  return { ok: true };
}

/**
 * 回复一条反馈：用邮件发到对方邮箱（见 lib/feedback-reply.ts），发出去了才留底、才算处理过了。
 * 发不出去就原样报错、什么都不记——「运营台上显示回过了、其实对方没收到」比没回更糟。
 */
export async function 回复反馈(input: { token: string; id: string; to: string; body: string }): Promise<AdminResult> {
  const g = await guard(input.token);
  if (!g.ok) return g;
  const 查 = 查回复(input.to, input.body);
  if (!查.ok) return 查;
  if (!回复通道可用()) return { ok: false, error: "邮件通道没配好（SMTP），发不出去" };
  const f = await control.feedback.findUnique({ where: { id: input.id } });
  if (!f) return { ok: false, error: "这条反馈不在了" };

  // 谁在回（只留底用，回信地址是固定的公司邮箱）：从桌面端进来的有运营账号；用网址口令进来的不知道是谁
  const 运营 = await 当前运营账号();
  const 运营邮箱 = 运营 ? ((await control.account.findUnique({ where: { id: 运营 }, select: { email: true } }))?.email ?? null) : null;

  const 信 = 组回复邮件({ to: 查.to, body: 查.body, 原话: f.body, 原话时间: f.at, replyTo: 回信地址() });
  try {
    await 发回复(信);
  } catch (e) {
    console.error("[feedback] 回复邮件发送失败：", e instanceof Error ? e.message : e);
    return { ok: false, error: "邮件没发出去，稍后再试" };
  }
  await control.$transaction([
    control.feedbackReply.create({ data: { feedbackId: f.id, to: 查.to, body: 查.body, by: 运营邮箱 ?? "口令" } }),
    control.feedback.update({ where: { id: f.id }, data: { handled: true } }),
  ]);
  revalidatePath("/admin", "layout");
  return { ok: true };
}
