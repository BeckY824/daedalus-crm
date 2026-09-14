"use server";

import { headers } from "next/headers";
import { 发送重置码 as 发, 重置密码 as 重置, type 发码结果, type 重置结果 } from "@/lib/tenant/password-reset";
import { 解析来源IP } from "@/lib/rate-limit";

/**
 * 找回密码的网页入口。规则整套在 lib/tenant/password-reset.ts——
 * 桌面端走 /api/account/password，用的是同一份实现，这里只负责把来源 IP 取出来。
 *
 * 页面跳过了动作也得自己拦（那边每个动作开头都会再判一次能不能找回）：
 * Server Action 是独立的 HTTP 端点，不经过页面也调得到。
 */
async function 来源IP(): Promise<string | null> {
  return 解析来源IP((await headers()).get("x-forwarded-for"));
}

export async function 发送重置码(target: string): Promise<发码结果> {
  return 发(target, await 来源IP());
}

export async function 重置密码(input: { target: string; code: string; password: string }): Promise<重置结果> {
  return 重置(input, await 来源IP());
}
