import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import { prisma } from "./prisma";
import { readSecret } from "./secret";
import { multiTenant, runWithTenant } from "./tenant/context";
import { resolveCurrentTenant } from "./tenant/resolve";
import { 会话已作废 } from "./tenant/session-cutoff";

export const SECRET = new TextEncoder().encode(
  readSecret(),
);

export const COOKIE = "crm_session";

/**
 * 是否要求 HTTPS 才下发会话 cookie。
 * 用域名 + HTTPS 部署时设为 true；用 IP + HTTP 临时访问时必须为 false，
 * 否则浏览器会直接丢弃 cookie，表现为「密码正确但一直停在登录页」。
 */
const COOKIE_SECURE =
  process.env.COOKIE_SECURE === "true" ||
  (process.env.COOKIE_SECURE === undefined && process.env.NODE_ENV === "production");

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  title: string;
  avatar?: string | null;
};

/**
 * 建立会话。
 *
 * 自部署：sub 是业务库的 User.id，和以前一样。
 * 托管版：sub 是控制面的 Account.id，另外带一个 ws（工作区 id）——
 *   「你是谁」和「你现在在哪个工作区」必须都在票据里，
 *   否则每次请求都要再查一次成员关系才知道该开哪个库。
 */
export async function createSession(userId: string, workspaceId?: string) {
  const token = await new SignJWT(workspaceId ? { sub: userId, ws: workspaceId } : { sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(SECRET);

  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: COOKIE_SECURE,
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function destroySession() {
  const store = await cookies();
  store.delete(COOKIE);
}

/** 读取当前登录用户，未登录返回 null */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, SECRET);
    const id = payload.sub as string;

    if (multiTenant()) {
      /**
       * 改过密码之后签发在改密之前的票据一律不认。
       * JWT 收不回来，找回密码只换密码的话，拿着旧 Cookie 的人还能再用 7 天。
       *
       * 同一道闸在 resolve.ts 里还有一份（那边是数据面的，prisma 直接问它要工作区）。
       * 这里这份不走那边的 10 秒缓存，为的是改完密码**立刻**把别的设备踢下线；
       * 那边那份管的是「连库都开不了」。两份都要，少哪一份都漏一类入口。
       *
       * 都不放在 proxy.ts：那里跑在 Edge 运行时，连不了控制面库。
       */
      if (await 会话已作废(id, typeof payload.iat === "number" ? payload.iat : undefined)) return null;
      // 成员关系被撤销 / 工作区被删 → 会话立刻失效，不给宽限
      const tenant = await resolveCurrentTenant();
      if (!tenant) return null;
      // 这几条查询显式包在工作区上下文里，省掉各自再解析一次
      return runWithTenant(tenant, async () => {
        // 账号 → 这个工作区里的那个 User。映射表见 migrations/004
        const link = await prisma.workspaceAccount.findFirst({ where: { accountId: id } });
        if (!link) return null;
        const me = await prisma.user.findFirst({ where: { id: link.userId, active: true } });
        if (!me) return null;
        return { id: me.id, name: me.name, email: me.email, role: me.role, title: me.title, avatar: me.avatar };
      });
    }

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user || !user.active) return null;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      title: user.title,
      avatar: user.avatar,
    };
  } catch {
    return null;
  }
}

/**
 * 页面/Server Action 内强制要求登录。
 *
 * 会话无效时必须跳去 /api/auth/logout 而不是直接跳 /login：
 * 无效的 Cookie 仍然存在，proxy.ts 只看 Cookie 是否存在，
 * 直接跳 /login 会被 proxy 再弹回 /dashboard，形成重定向死循环。
 * 该路由会先清除 Cookie，再跳转登录页。
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/api/auth/logout");
  return user;
}
