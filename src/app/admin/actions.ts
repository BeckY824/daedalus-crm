"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { control } from "@/lib/tenant/control";
import { multiTenant } from "@/lib/tenant/context";
import { isPlanKey, PLANS } from "@/lib/tenant/plans";
import { createWorkspace } from "@/lib/tenant/workspaces";
import { createAccount, findAccountByTarget, parseTarget } from "@/lib/tenant/accounts";
import { 加次数 } from "@/lib/tenant/ai-allowance";

export type AdminResult = { ok: true } | { ok: false; error: string };

/**
 * 运营台的动作。
 *
 * 每个动作都要重新验 token：Server Action 是独立的 HTTP 端点，页面那次校验
 * 拦不住直接调用它的人。「页面进得来所以动作能调」是最常见的一类越权。
 */
function guard(token: string): AdminResult {
  const expected = process.env.ADMIN_TOKEN;
  if (!multiTenant() || !expected || token !== expected) return { ok: false, error: "无权操作" };
  return { ok: true };
}

/** 手动开通：按套餐从今天或现有到期日往后顺延 */
export async function activate(input: { token: string; workspaceId: string; plan: string; note?: string }): Promise<AdminResult> {
  const g = guard(input.token);
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
  revalidatePath("/admin");
  return { ok: true };
}

/** 延长试用：谈单过程中常用，比直接开通更轻 */
export async function extendTrial(input: { token: string; workspaceId: string; days: number }): Promise<AdminResult> {
  const g = guard(input.token);
  if (!g.ok) return g;
  const days = Math.max(1, Math.min(90, Math.round(input.days)));

  const ws = await control.workspace.findUnique({ where: { id: input.workspaceId } });
  if (!ws) return { ok: false, error: "工作区不存在" };

  const base = ws.trialEndsAt > new Date() ? ws.trialEndsAt : new Date();
  await control.workspace.update({
    where: { id: input.workspaceId },
    data: { trialEndsAt: new Date(base.getTime() + days * 86_400_000), status: ws.status === "SUSPENDED" ? "TRIAL" : ws.status },
  });
  revalidatePath("/admin");
  return { ok: true };
}

/** 停用：滥用或欠费时用。数据不动，只是进不去 */
export async function suspend(input: { token: string; workspaceId: string; on: boolean }): Promise<AdminResult> {
  const g = guard(input.token);
  if (!g.ok) return g;
  await control.workspace.update({
    where: { id: input.workspaceId },
    data: { status: input.on ? "SUSPENDED" : "TRIAL" },
  });
  revalidatePath("/admin");
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
  const g = guard(input.token);
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
    revalidatePath("/admin");
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
  const g = guard(input.token);
  if (!g.ok) return g;
  await 加次数(input.workspaceId, input.amount, input.note ?? "运营台");
  revalidatePath("/admin");
  return { ok: true };
}

/**
 * 反馈标记处理过了（可以来回切）。
 * 不提供删除：一条反馈是有人花时间写的，读过就收起来，但不该被一个误点抹掉。
 */
export async function 标记反馈(input: { token: string; id: string; handled: boolean }): Promise<AdminResult> {
  const g = guard(input.token);
  if (!g.ok) return g;
  await control.feedback.update({ where: { id: input.id }, data: { handled: input.handled } });
  revalidatePath("/admin");
  return { ok: true };
}
