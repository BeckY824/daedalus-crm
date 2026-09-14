import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * 桌面端本地模式的自动登录。
 *
 * 本地模式下服务只监听 127.0.0.1，数据库文件就躺在用户自己的目录里——
 * 再要一次登录不增加任何安全性，只是每次打开应用都要输一遍密码。
 * 所以由 Electron 在启动时带着一次性令牌访问这里，换一张会话票据。
 *
 * 三道闸，少一道都不行：
 *   1. 没有 DESKTOP_LOCAL=1 就当这个路由不存在——托管版和自部署版都不会开这个开关，
 *      构建产物里虽然有这个文件，但它在那两种部署里永远返回 404。
 *   2. 令牌由 Electron 每次启动现生成，只存在于父子进程的环境变量里，不落盘。
 *   3. 令牌用定长比较，不给计时侧信道留口子。
 *
 * 登录的是业务库里第一个管理员。本地模式是单人使用，不存在"该登谁"的歧义；
 * 想以别的身份进去，登出后用账号密码正常登录即可（密码见应用菜单）。
 */
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

  const admin = await prisma.user.findFirst({
    where: { role: "ADMIN", active: true },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!admin) return new NextResponse("本机数据库里还没有账号", { status: 500 });

  await createSession(admin.id);
  /**
   * 用相对地址跳，不用 NextResponse.redirect(new URL(..., req.url))。
   * 后者会把 req.url 里的 host 拼进去，而那个 host 未必是浏览器正在用的那个
   * （实测 127.0.0.1 的请求会被规范成 localhost）——会话 cookie 是按访问时的
   * 主机名下发的，跳到另一个主机名上就等于没登录，表现是自动登录完又被弹回登录页。
   */
  return new NextResponse(null, { status: 307, headers: { Location: "/dashboard" } });
}
