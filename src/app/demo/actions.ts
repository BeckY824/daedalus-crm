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
import { 检查限流, 记一次失败, 解析来源IP, IP阈值 } from "@/lib/rate-limit";

export type DemoResult = { ok: false; error: string };

/**
 * 进演示区。
 *
 * 这是全站唯一一个不校验密码就签发会话的地方，边界收得很窄：
 *   - 目标工作区只能来自 DEMO_WORKSPACE，请求里任何东西都不参与决定进哪个库
 *   - 种一个访客 cookie，AI 次数按它数（5 次）——不数的话演示区就是个账单黑洞
 *   - 按 IP 限流
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
  }

  const store = await cookies();
  const visitor = store.get(演示访客Cookie)?.value || randomUUID();
  await 进入演示区(visitor);

  store.set(演示访客Cookie, visitor, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
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
