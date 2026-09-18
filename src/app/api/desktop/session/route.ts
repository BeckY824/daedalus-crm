import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { 读 as 读云端凭据 } from "@/lib/desktop/cloud";

export const dynamic = "force-dynamic";

/**
 * 桌面端本地模式的自动登录。
 *
 * 本地模式下服务只监听 127.0.0.1，数据库文件就躺在用户自己的目录里——
 * 再要一次密码不增加任何安全性，只是每次打开应用都要输一遍。
 * 所以由 Electron 在启动时带着一次性令牌访问这里，换一张会话票据。
 *
 * 三道闸，少一道都不行：
 *   1. 没有 DESKTOP_LOCAL=1 就当这个路由不存在——托管版和自部署版都不会开这个开关，
 *      构建产物里虽然有这个文件，但它在那两种部署里永远返回 404。
 *   2. 令牌由 Electron 每次启动现生成，只存在于父子进程的环境变量里，不落盘。
 *   3. 令牌用定长比较，不给计时侧信道留口子。
 *
 * **门是云端账号**：本机没有 .cloud.json（还没登录、或者退出了、或者令牌被吊销后清掉了）
 * 就回登录页，那一页画的是云端账号的登录表单（app/login/page.tsx）。登录成功后
 * 由那个表单的动作直接建会话，不再回到这里。
 *
 * 会话签给业务库里第一个管理员——本地模式是单人使用，他就是登录的那个云端账号
 * （登录动作和 server-entry.js 都会把他的名字、邮箱对成账号的）。
 */
/**
 * 壳带来的「回到上一页」。只认站内的应用路径：登录、找回、API、后台这些不是落点，
 * 协议相对地址（//evil）更不是。收不下的一律回 /dashboard。
 */
export function 选落点(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/dashboard";
  const 路径 = next.split("?")[0];
  if (路径 === "/" || /^\/(login|signup|forgot|api|admin|_next)(\/|$)/.test(路径)) return "/dashboard";
  return next;
}

export async function GET(req: Request) {
  const expected = process.env.DESKTOP_TOKEN;
  if (process.env.DESKTOP_LOCAL !== "1" || !expected) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const given = new URL(req.url).searchParams.get("t") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // 长度不同时 timingSafeEqual 会抛错，先比长度再比内容
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  if (!读云端凭据()) {
    /**
     * 没登录云端账号（还没登、退出了、被吊销后清掉了）。**经 logout 走**而不是直接去 /login：
     * 业务会话 cookie 可能还活着（7 天），直接去 /login 会被 proxy.ts 弹回 /dashboard，
     * 人就带着一个失效的云端账号进了应用。壳传来的原因（reason）原样带过去。
     */
    const reason = new URL(req.url).searchParams.get("reason");
    return new NextResponse(null, { status: 307, headers: { Location: `/api/auth/logout${reason ? `?reason=${encodeURIComponent(reason)}` : ""}` } });
  }

  const admin = await prisma.user.findFirst({
    where: { role: "ADMIN", active: true },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  /**
   * 库里没有在职管理员（被停用过、或者搬了一个残缺的库进来）。不能回 500：
   * 500 等于把人锁在应用外面，一个字的解释都没有。回登录页，带上原因。
   */
  if (!admin) return new NextResponse(null, { status: 307, headers: { Location: "/login?reason=noadmin" } });

  await createSession(admin.id);
  /**
   * 用相对地址跳，不用 NextResponse.redirect(new URL(..., req.url))。
   * 后者会把 req.url 里的 host 拼进去，而那个 host 未必是浏览器正在用的那个
   * （实测 127.0.0.1 的请求会被规范成 localhost）——会话 cookie 是按访问时的
   * 主机名下发的，跳到另一个主机名上就等于没登录，表现是自动登录完又被弹回登录页。
   */
  return new NextResponse(null, { status: 307, headers: { Location: 选落点(new URL(req.url).searchParams.get("next")) } });
}
