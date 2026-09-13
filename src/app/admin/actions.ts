"use server";

import { revalidatePath } from "next/cache";
import { control } from "@/lib/tenant/control";
import { multiTenant } from "@/lib/tenant/context";
import { isPlanKey, PLANS } from "@/lib/tenant/plans";

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
