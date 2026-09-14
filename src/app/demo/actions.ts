"use server";

import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSession } from "@/lib/auth";
import { multiTenant } from "@/lib/tenant/context";
import { demoSlug } from "@/lib/demo/config";
import { 演示票据信息 } from "@/lib/demo/workspace";
import { 绑定演示码, 演示码剩余 } from "@/lib/tenant/activation";
import { 演示访客Cookie } from "@/lib/tenant/ai-allowance";
import { 检查限流, 记一次失败, 解析来源IP, IP阈值 } from "@/lib/rate-limit";

export type DemoResult = { ok: false; error: string };

/**
 * 用演示码进演示区。
 *
 * 这是全站唯一一个不校验密码就签发会话的地方，边界收得很窄：
 *   - 目标工作区只能来自 DEMO_WORKSPACE，请求里任何东西都不参与决定进哪个库
 *   - 进门要演示码，码绑定到这个浏览器的 cookie（一码一人），之后按它数 5 次 AI
 *   - 按 IP 限流，猜码越猜越慢
 * 成功直接 redirect，redirect 会 throw，所以它必须在 try/catch 外面。
 */
export async function enterDemo(raw: string): Promise<DemoResult> {
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
  const r = await 绑定演示码(raw, visitor);
  if (!r.ok) {
    if (from) 记一次失败(`demo:${from}`, Date.now(), IP阈值);
    return r;
  }

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

/** 已经绑过码的浏览器：不用再输，直接进 */
export async function continueDemo(): Promise<DemoResult> {
  if (!multiTenant() || !demoSlug()) return { ok: false, error: "演示区没有开放" };
  const info = await 演示票据信息();
  if (!info) return { ok: false, error: "演示区还没建好，稍后再试" };
  const visitor = (await cookies()).get(演示访客Cookie)?.value;
  if (!visitor || !(await 演示码剩余(visitor))) return { ok: false, error: "这个浏览器还没用演示码进入过" };
  await createSession(info.accountId, info.workspaceId);
  redirect("/dashboard");
}
