"use server";

import { cookies } from "next/headers";
import { createSession, getCurrentUser } from "@/lib/auth";
import { multiTenant } from "@/lib/tenant/context";
import { accessibleWorkspace } from "@/lib/tenant/workspace-access";
import { 最近客户键 } from "@/lib/last-customer";

export async function 切换工作区(workspaceId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!multiTenant()) return { ok: false, error: "当前部署没有工作区切换" };
  if (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > 100) return { ok: false, error: "请选择可进入的工作区" };
  const me = await getCurrentUser();
  if (!me?.accountId) return { ok: false, error: "登录已失效，请重新登录" };
  if (!(await accessibleWorkspace(me.accountId, workspaceId))) return { ok: false, error: "无法进入这个工作区，请刷新名单或联系管理员" };
  await createSession(me.accountId, workspaceId);
  (await cookies()).delete(最近客户键);
  return { ok: true };
}
