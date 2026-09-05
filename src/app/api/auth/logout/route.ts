import { NextResponse, type NextRequest } from "next/server";
import { destroySession } from "@/lib/auth";

/** 前端主动退出 */
export async function POST() {
  await destroySession();
  return NextResponse.json({ ok: true });
}

/**
 * 会话失效时的兜底出口：清掉 Cookie 再跳登录页。
 * requireUser() 检测到无效会话时会重定向到这里 —— 若直接跳 /login，
 * proxy.ts 见 Cookie 仍在会把请求弹回 /dashboard，导致死循环。
 */
export async function GET(request: NextRequest) {
  await destroySession();
  return NextResponse.redirect(new URL("/login", request.url));
}
