"use server";

import { headers } from "next/headers";
import { 发送重置码 as 发, 重置密码 as 重置, type 发码结果, type 重置结果 } from "@/lib/tenant/password-reset";
import { 解析来源IP } from "@/lib/rate-limit";
import { 本地模式, 发码 as 云端发码, 重置密码 as 云端重置密码, 清 as 清云端凭据, 核对验证码 as 云端核对验证码 } from "@/lib/desktop/cloud";
import { checkCode, parseTarget } from "@/lib/tenant/accounts";
import { multiTenant } from "@/lib/tenant/context";
import { 检查限流, 记一次失败, IP阈值 } from "@/lib/rate-limit";

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

/**
 * 输码那一步填满 6 位时先问一句码对不对（只核对、不用掉，错的照样算一次——lib/tenant/accounts.ts 的 checkCode）。
 * 桌面端转调云端；网页版就在这儿核对，同样按来源 IP 限一档。核对不了就当对，改密码那一步还会再验
 */
export async function 核对重置码(target: string, code: string): Promise<{ 对: boolean; error?: string }> {
  if (本地模式()) return 云端核对验证码(target.trim(), code, "reset");
  // 没有账号体系的部署（自部署单租户）没有控制面，也走不到找回密码；保险起见不去碰它
  if (!multiTenant()) return { 对: true };
  const t = parseTarget(target.trim());
  if (!t) return { 对: true };
  const from = await 来源IP();
  if (from) {
    const 还要等 = 检查限流(`codecheck:${from}`);
    if (还要等 != null) return { 对: false, error: `操作太频繁，请 ${还要等} 秒后再试` };
  }
  const r = await checkCode(t.value, code, "reset");
  if (r.ok) return { 对: true };
  if (from) 记一次失败(`codecheck:${from}`, Date.now(), IP阈值);
  return { 对: false, error: r.error };
}
