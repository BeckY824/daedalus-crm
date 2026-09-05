import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import { prisma } from "./prisma";
import { readSecret } from "./secret";

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

export async function createSession(userId: string) {
  const token = await new SignJWT({ sub: userId })
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
