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

/** 和 lib/desktop/local-guard.ts 的 是本机地址 同一条（proxy 跑在 Edge，那边用了 node:crypto，不直接引） */
function 本机地址(host: string | null): boolean {
  if (!host) return false;
  const 名 = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return 名 === "127.0.0.1" || 名 === "localhost" || 名 === "[::1]";
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  /*
    桌面端本地模式只认本机地址（2026-10-04，D-1）：恶意网页把自己的域名重绑定到 127.0.0.1，
    浏览器会带着那个域名的 Host 来访问本地服务。不是 127.0.0.1 / localhost / [::1] 的一律拒
  */
  if (process.env.DESKTOP_LOCAL === "1" && !本机地址(request.headers.get("host"))) {
    return new NextResponse("Misdirected Request", { status: 421 });
  }
  const valid = await hasValidSession(request);

  // 未登录也能看的页面。注册页只在托管版有内容，自部署版进去会被服务端动作拒绝；
  // /admin 是我们的运营台，不属于任何工作区，用它自己的 ADMIN_TOKEN 保护；
  // /terms 与 /privacy 是注册前要读的条款，当然不能要求先登录；
  // /forgot 是找回密码，忘了密码的人当然是未登录状态；
  const 公开 =
    pathname === "/login" || pathname === "/signup" || pathname === "/forgot" || pathname === "/terms" || pathname === "/privacy" || pathname.startsWith("/admin");

  if (!valid && !公开) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    const res = NextResponse.redirect(url);
    // 过期/损坏的 Cookie 就地清掉，避免下一次请求再走一遍
    res.cookies.delete(COOKIE);
    return res;
  }

  // 已登录时把登录/注册页弹回应用内。这两个不弹：
  //   /admin  —— 我们自己常是登录状态，弹了就进不去运营台；
  //   /forgot —— 要允许「已登录的人也能给自己重置」：密码泄露了想立刻换掉，
  //              弹回去他就没路走了（应用内还没有改密码的入口）。
  //   桌面端本地模式的 /login —— 那一页是「云端账号」的门（2026-09-21 起账号可选）。
  //              人已经在本地 CRM 里了，正是从「设置 → 桌面端 → 登录云端账号」过来登云端的；
  //              弹回首页等于这扇门永远进不去（0.46.3 就是这样，录教程时撞到）。
  //              已经登过云端的，登录页自己会一步不停地送回应用（login/page.tsx）。
  const 本地云端门 = process.env.DESKTOP_LOCAL === "1" && pathname === "/login";
  if (valid && !本地云端门 && (pathname === "/login" || pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  /**
   * /reports 并进了 /overview（见 app/(app)/reports/page.tsx，那份留着兜底）。跳转放在这里而不是页面里：
   * 页面里的 redirect() 碰上已经开始流式输出的布局，Next 只能退成客户端跳转——旧书签点进来
   * 先看到一页空白的外壳再跳（e2e 零数据巡检 600ms 时抓到的就是这一瞬）。这里是一个干净的 307。
   * 不写进 next.config 的 redirects：目标里有中文，那边会把它解码进 Location 头，直接 500。
   */
  if (valid && pathname === "/reports") {
    const url = request.nextUrl.clone();
    url.pathname = "/overview";
    url.search = "";
    url.searchParams.set("view", "本年");
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
