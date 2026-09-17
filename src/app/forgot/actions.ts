"use server";

import { headers } from "next/headers";
import { 发送重置码 as 发, 重置密码 as 重置, type 发码结果, type 重置结果 } from "@/lib/tenant/password-reset";
import { 解析来源IP } from "@/lib/rate-limit";
import { 本地模式, 发码 as 云端发码, 重置密码 as 云端重置密码, 清 as 清云端凭据 } from "@/lib/desktop/cloud";

/**
 * 找回密码的网页入口。规则整套在 lib/tenant/password-reset.ts——
 * 桌面端走 /api/account/password，用的是同一份实现，这里只负责把来源 IP 取出来。
 *
 * 页面跳过了动作也得自己拦（那边每个动作开头都会再判一次能不能找回）：
 * Server Action 是独立的 HTTP 端点，不经过页面也调得到。
 *
 * **桌面端本地模式转调云端**：本机的服务没有控制面也发不出信，账号在云端，
 * 所以两个动作都原样交给 app.ai-daedalus.com 上的同一套接口（lib/desktop/cloud.ts）。
 * 页面一个字不用改。
 */
async function 来源IP(): Promise<string | null> {
  return 解析来源IP((await headers()).get("x-forwarded-for"));
}

export async function 发送重置码(target: string): Promise<发码结果> {
  if (本地模式()) {
    const r = await 云端发码(target.trim());
    return r.ok ? { ok: true, hint: r.data?.hint } : { ok: false, error: r.error };
  }
  return 发(target, await 来源IP());
}

export async function 重置密码(input: { target: string; code: string; password: string }): Promise<重置结果> {
  if (本地模式()) {
    const r = await 云端重置密码(input);
    if (!r.ok) return { ok: false, error: r.error };
    // 改密码 = 所有机器退出，这台也在内。本地那枚令牌已经作废了，留着只会让下次启动多问一句
    清云端凭据();
    return { ok: true };
  }
  return 重置(input, await 来源IP());
}
