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
import { 赠送 } from "@/lib/tenant/credits";
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

/** 团队同步：开通 / 停用一个团队（2026-10-03）。停用后成员推拉都回「还没开通」，本机数据不受影响 */
export async function setSyncTeam(input: { token: string; teamId: string; on: boolean }): Promise<AdminResult> {
  const g = await guard(input.token);
  if (!g.ok) return g;
  const { 设开通 } = await import("@/lib/tenant/sync-relay");
  await 设开通(input.teamId, input.on);
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
 * 给一个桌面端账号手动加 AI 次数（用户详情页的「AI 次数 +10」）。
 * 和工作区那条一个口径：一次 1–1000，记成 admin；账号不存在就说不存在，不往空里送。
 */
export async function grantAccountAi(input: { token: string; accountId: string; amount: number; note?: string }): Promise<AdminResult> {
  const g = await guard(input.token);
  if (!g.ok) return g;
  const a = await control.account.findUnique({ where: { id: input.accountId }, select: { id: true } });
  if (!a) return { ok: false, error: "账号不存在" };
  const n = Math.max(1, Math.min(1000, Math.floor(input.amount)));
  await 赠送({ kind: "account", id: a.id }, { amount: n, reason: "admin", note: input.note ?? "运营台" });
  revalidatePath("/admin", "layout");
  return { ok: true };
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
