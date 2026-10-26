"use server";

import { requireUser } from "@/lib/auth";
import { 企业版 } from "@/lib/enterprise/switch";
import { 没读的提醒, 读过提醒, type 企业提醒 } from "@/lib/enterprise/notice";

/**
 * 企业版站内提醒（2026-10-26，lib/enterprise/notice.ts）：打开应用时 components/EntNoticePrompt 来拿自己没读的，
 * 点「知道了」标成读过。只认登录的这个人：传别人的提醒 id 什么也不改。
 */
export async function 我的企业提醒(): Promise<企业提醒[]> {
  if (!企业版()) return [];
  const me = await requireUser();
  return 没读的提醒(me.id);
}

export async function 已读企业提醒(id: string): Promise<boolean> {
  if (!企业版() || typeof id !== "string" || !id) return false;
  const me = await requireUser();
  return 读过提醒(me.id, id);
}
