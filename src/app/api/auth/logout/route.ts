import { NextResponse, type NextRequest } from "next/server";
import { destroySession } from "@/lib/auth";
import { 本地模式, 退出 as 退出云端 } from "@/lib/desktop/cloud";

/**
 * 前端主动退出。
 *
 * 桌面端本地模式下，退的是**云端账号**：吊销这台机器的设备令牌、删掉本地那份 .cloud.json。
 * 本机业务会话只是顺带清掉——它本来就是靠云端账号自动签的（api/desktop/session）。
 * 退完落到 /login，那一页画的是云端账号的登录表单，注册、找回密码都在。
 */
export async function POST() {
  await destroySession();
  if (本地模式()) await 退出云端();
  return NextResponse.json({ ok: true });
}

/**
 * 会话失效时的兜底出口：清掉 Cookie 再跳登录页。
 * requireUser() 检测到无效会话时会重定向到这里 —— 若直接跳 /login，
 * proxy.ts 见 Cookie 仍在会把请求弹回 /dashboard，导致死循环。
 *
 * 这里**不动云端账号**：业务会话过期不等于人要退出，桌面端手上的令牌还在，
 * /login 会拿它自动再进来。
 *
 * 反过来的情况也走这里：桌面端手上的令牌**没了**（退出、被吊销），但业务会话 cookie 还活着
 * （它有 7 天）。这时直接跳 /login 会被 proxy.ts 弹回 /dashboard，人就带着一个失效的
 * 云端账号继续用——AI 在背后一路 401。所以壳和自动登录路由都是先来这里清掉 cookie 再落到门口。
 */
export async function GET(request: NextRequest) {
  await destroySession();
  const url = new URL("/login", request.url);
  // 壳把人送回门口时会说明原因（令牌被吊销了），原样带到登录页那句话上
  const reason = request.nextUrl.searchParams.get("reason");
  if (reason) url.searchParams.set("reason", reason);
  return NextResponse.redirect(url);
}
