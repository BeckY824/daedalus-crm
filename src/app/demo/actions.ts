"use server";

import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSession } from "@/lib/auth";
import { multiTenant } from "@/lib/tenant/context";
import { demoSlug } from "@/lib/demo/config";
import { 演示票据信息 } from "@/lib/demo/workspace";
import { 进入演示区, 演示剩余 } from "@/lib/tenant/demo-visitor";
import { 演示访客Cookie } from "@/lib/tenant/ai-allowance";
import { 检查限流, 记一次失败, 解析来源IP, IP阈值, 今日计数, 记一次今日, 每IP每日演示上限 } from "@/lib/rate-limit";

export type DemoResult = { ok: false; error: string };

/**
 * 进演示区。
 *
 * 这是全站唯一一个不校验密码就签发会话的地方，边界收得很窄：
 *   - 目标工作区只能来自 DEMO_WORKSPACE，请求里任何东西都不参与决定进哪个库
 *   - 种一个访客 cookie，AI 次数按它数（5 次）——不数的话演示区就是个账单黑洞
 *   - 按 IP 数进门次数：码没了之后，这是唯一挡住「一个脚本刷出几万条访客记录」的东西
 *
 * 原来进门还要一个「演示码」（运营台批量生成、一码一人）。整套码 2026-09-15 下线：
 * 它挡住的主要是**想看看的人**，而真要薅额度的人换个浏览器就绕过去了。
 * 按访客计数这件事留着，那才是真正管住成本的那一半。
 *
 * 成功直接 redirect，redirect 会 throw，所以它必须在 try/catch 外面。
 */
export async function enterDemo(): Promise<DemoResult> {
  if (!multiTenant() || !demoSlug()) return { ok: false, error: "演示区没有开放" };
  const info = await 演示票据信息();
  if (!info) return { ok: false, error: "演示区还没建好，稍后再试" };

  const from = 解析来源IP((await headers()).get("x-forwarded-for"));
  if (from) {
    const 还要等 = 检查限流(`demo:${from}`);
    if (还要等 != null) return { ok: false, error: `操作太频繁，请 ${还要等} 秒后再试` };
    /**
     * 每进一次记一笔，到 IP 阈值就冷却一会儿。
     *
     * 这里记的不是"失败"而是"发生了一次"——限流那套本来就是按次数计的。
     * 原来这个位置只在**码填错**时记，码没了之后那条路一次都走不到，
     * 于是上面那句 检查限流 永远返回 null，等于没有闸：
     * 一个脚本能不停地进，每进一次就多一行 DemoVisitor。
     * 阈值用 IP 档（30 次）而不是账号档：办公室共用一个出口 IP 是常事。
     */
    记一次失败(`demo:${from}`, Date.now(), IP阈值);
  }

  const store = await cookies();
  const 老访客 = store.get(演示访客Cookie)?.value || null;
  /**
   * 新访客要占一个当天的名额：一次进门就是一份新的 5 次额度，
   * 而「换一个访客」只要把 cookie 丢掉——上面那个冷却管频率，管不住总量。
   * 带着 cookie 回来的人不占：他本来就只有原来那一份。
   */
  if (!老访客 && from && 今日计数(`demo:${from}`) >= 每IP每日演示上限) {
    return { ok: false, error: "今天从这个网络进演示区的人已经够多了，明天再来。想接着用就注册一个自己的工作区" };
  }
  const visitor = 老访客 || randomUUID();
  await 进入演示区(visitor);
  if (!老访客 && from) 记一次今日(`demo:${from}`);

  store.set(演示访客Cookie, visitor, {
    httpOnly: true,
    sameSite: "lax",
    // 和会话 cookie 同一条判据（lib/auth.ts）：没显式设时线上默认要 HTTPS
    secure: process.env.COOKIE_SECURE === "true" || (process.env.COOKIE_SECURE === undefined && process.env.NODE_ENV === "production"),
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  await createSession(info.accountId, info.workspaceId);
  redirect("/dashboard");
}

/** 之前进过的浏览器：直接进，额度接着上次算 */
export async function continueDemo(): Promise<DemoResult> {
  if (!multiTenant() || !demoSlug()) return { ok: false, error: "演示区没有开放" };
  const info = await 演示票据信息();
  if (!info) return { ok: false, error: "演示区还没建好，稍后再试" };
  const visitor = (await cookies()).get(演示访客Cookie)?.value;
  if (!visitor || !(await 演示剩余(visitor))) return { ok: false, error: "这个浏览器还没进过演示区" };
  await createSession(info.accountId, info.workspaceId);
  redirect("/dashboard");
}
