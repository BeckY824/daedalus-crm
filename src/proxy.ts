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
  // /admin 是我们的运营台，不属于任何工作区，用它自己的 ADMIN_TOKEN 保护
  const 公开 = pathname === "/login" || pathname === "/signup" || pathname.startsWith("/admin");

  if (!valid && !公开) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    const res = NextResponse.redirect(url);
    // 过期/损坏的 Cookie 就地清掉，避免下一次请求再走一遍
    res.cookies.delete(COOKIE);
    return res;
  }

  // 已登录时把登录/注册页弹回应用内；/admin 不弹——我们自己常常是登录状态
  if (valid && (pathname === "/login" || pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // 排除 API 路由与静态资源；/api/auth/logout 需要能自行清 Cookie 后跳转
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
