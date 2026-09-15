import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

/**
 * 与 lib/auth.ts 保持一致：生产环境缺少 AUTH_SECRET 时直接失败，
 * 不允许静默回落到硬编码默认值（那等于放任任何人伪造登录凭证）。
 */
function readSecret(): string {
  const s = process.env.AUTH_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET 未设置或长度不足 32 位，拒绝启动。");
  }
  return "dev-only-secret-change-me-in-production";
}

const SECRET = new TextEncoder().encode(readSecret());

const COOKIE = "crm_session";

/**
 * 校验 JWT 的签名与有效期。这里跑在 Edge 运行时，连不了数据库，
 * 所以"用户是否仍然存在/在职"由 (app)/layout.tsx 的 getCurrentUser 复查。
 */
async function hasValidSession(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(COOKIE)?.value;
  if (!token) return false;
  try {
    await jwtVerify(token, SECRET);
    return true;
  } catch {
    return false;
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const valid = await hasValidSession(request);

  // 未登录也能看的页面。注册页只在托管版有内容，自部署版进去会被服务端动作拒绝；
  // /admin 是我们的运营台，不属于任何工作区，用它自己的 ADMIN_TOKEN 保护；
  // /terms 与 /privacy 是注册前要读的条款，当然不能要求先登录；
  // /forgot 是找回密码，忘了密码的人当然是未登录状态；
  // /demo 是演示入口，它的职责就是**给没有会话的人签一张会话**——
  // 要是拦在这里，它永远等不到执行的机会，表现是点「在线试用」弹回登录页。
  // 它自己会在没配 DEMO_WORKSPACE 时返回 404，不靠这里把关。
  const 公开 =
    pathname === "/login" || pathname === "/signup" || pathname === "/forgot" || pathname === "/demo" || pathname === "/terms" || pathname === "/privacy" || pathname.startsWith("/admin");

  if (!valid && !公开) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    const res = NextResponse.redirect(url);
    // 过期/损坏的 Cookie 就地清掉，避免下一次请求再走一遍
    res.cookies.delete(COOKIE);
    return res;
  }

  // 已登录时把登录/注册页弹回应用内。这三个不弹：
  //   /admin  —— 我们自己常是登录状态，弹了就进不去运营台；
  //   /demo   —— 要允许「已登录的人也能去看演示」，弹回 /dashboard 是点了没反应，
  //              比切走工作区更让人摸不着头脑；
  //   /forgot —— 要允许「已登录的人也能给自己重置」：密码泄露了想立刻换掉，
  //              弹回去他就没路走了（应用内还没有改密码的入口）。
  if (valid && (pathname === "/login" || pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  /**
   * 把路径写进请求头：(app)/layout.tsx 要按路由决定中栏放什么（首页放「今天」、学员放列表），
   * 而 Server Component 的布局拿不到路径，只有这里能给。只是一个只读的提示，不涉及权限。
   */
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // 排除 API 路由与静态资源；/api/auth/logout 需要能自行清 Cookie 后跳转
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
