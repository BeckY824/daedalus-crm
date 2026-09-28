"use client";

import { App } from "antd";
import { runJob } from "@/lib/ai-jobs";
import { useBusiness } from "@/lib/business-client";
import { draftWakeup } from "@/app/(app)/dashboard/ai";
import { draftInvite } from "@/app/(app)/channels/ai";

/**
 * 起草话术：首页对话里的客户行、记录页右栏、首页盯盘、渠道页转介绍雷达，四处原来各写一份。
 *
 * 任务挂在进程内任务表上（lib/ai-jobs），**四处共用同一个 key**：在盯盘里起的草，点进记录页照样看得到，
 * 切走再回来转圈和结果都还在。AI 只起草——消息由销售自己复制出去发，系统不做任何触达。
 */
export type 草稿类 = "wakeup" | "invite";

export const 草稿键 = (kind: 草稿类, customerId: string) => `draft:${kind}:${customerId}`;

/** reason 只对唤醒话术有用：说清为什么这时候去联系（盯盘给的是具体原因，别处写从哪儿发起的） */
export function 起草(kind: 草稿类, customerId: string, reason = "") {
  runJob(草稿键(kind, customerId), async () => {
    const res = kind === "wakeup" ? await draftWakeup({ customerId, reason }) : await draftInvite({ customerId });
    return res.ok ? { ok: true, value: res.message } : res;
  });
}

/** 复制话术，提示一句去哪儿发 */
export function useCopyDraft() {
  const { message } = App.useApp();
  const b = useBusiness();
  return async (text: string) => {
    await navigator.clipboard.writeText(text);
    message.success(`已复制，去微信发给${b.customer}吧`);
  };
}
