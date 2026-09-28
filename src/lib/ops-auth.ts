import { randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { readSecret } from "./secret";
import { control } from "./tenant/control";

/**
 * 从桌面端打开运营台（2026-09-28）：**只有一个运营账号能开**，不用再拷带口令的网址。
 *
 * 流程：
 *   1. 桌面端的壳拿设备令牌问 /api/ops/can：「我能开运营台吗」——能，菜单里才出现「运营台…」
 *   2. 点了，壳拿令牌去 /api/ops/enter 换一枚**一次性进门码**（60 秒，用一次就作废）
 *   3. 新窗口打开 /admin/enter?code=…，服务器验码、下发一张 12 小时的运营台票（httpOnly cookie），跳到 /admin
 *   4. 运营台每一页、每个动作认这张票（也照旧认网址上的 ADMIN_TOKEN，open-admin.sh 那条路不变）
 *
 * 为什么不直接把 ADMIN_TOKEN 发给桌面端：口令一旦落到客户端就收不回来，而且谁拿到谁能进。
 * 这里认的是「这个人」：设备令牌 → 账号 → 在不在运营名单里。改了密码（令牌全吊销）或者从名单里拿掉，立刻进不去。
 *
 * 票和登录会话用同一把密钥（AUTH_SECRET），但 audience 不同——互相不通用：
 * 业务会话拿来当运营台票不认，运营台票拿去登录业务也不认。
 */

export const 运营COOKIE = "crm_ops";
export const 运营票秒 = 12 * 60 * 60;
const 用途 = "crm-ops";
const 密钥 = () => new TextEncoder().encode(readSecret());

/** 运营名单：OPS_ACCOUNTS，逗号分隔的邮箱或手机号。没配 = 谁都开不了，这条路整个关着 */
export function 运营名单(env: Record<string, string | undefined> = process.env): string[] {
  return (env.OPS_ACCOUNTS ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 这个账号能不能开运营台：在名单里、而且没被停用 */
export async function 是运营账号(accountId: string): Promise<boolean> {
  const 名单 = 运营名单();
  if (名单.length === 0) return false;
  const a = await control.account.findUnique({ where: { id: accountId }, select: { email: true, phone: true, active: true } });
  if (!a || !a.active) return false;
  return [a.email, a.phone].some((x) => x && 名单.includes(x.toLowerCase()));
}

/**
 * 一次性进门码。放内存不放库：托管版是单进程，重启丢了也无所谓（60 秒内再点一次菜单就行），
 * 而放库就要多一张表、还得定期清。码本身是 24 字节随机数，猜不到；用一次就删。
 */
const 进门码们 = new Map<string, { accountId: string; 到期: number }>();

export function 发进门码(accountId: string, now = Date.now()): string {
  for (const [k, v] of 进门码们) if (v.到期 <= now) 进门码们.delete(k);
  const code = randomBytes(24).toString("hex");
  进门码们.set(code, { accountId, 到期: now + 60_000 });
  return code;
}

/** 用掉一枚进门码：对的话返回是谁，同一枚第二次就不认了 */
export function 用进门码(code: string | null | undefined, now = Date.now()): string | null {
  if (!code) return null;
  const v = 进门码们.get(code);
  进门码们.delete(code);
  if (!v || v.到期 <= now) return null;
  return v.accountId;
}

export async function 签运营票(accountId: string): Promise<string> {
  return new SignJWT({ sub: accountId })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(用途)
    .setIssuedAt()
    .setExpirationTime(`${运营票秒}s`)
    .sign(密钥());
}

/**
 * 认运营台票：签名对、没过期、用途对，**而且这个人此刻还在名单里、没被停用**——
 * 12 小时里把他从名单拿掉，下一次点击就进不去了，不用等票过期。
 */
export async function 认运营票(票: string | null | undefined): Promise<string | null> {
  if (!票) return null;
  try {
    const { payload } = await jwtVerify(票, 密钥(), { audience: 用途 });
    const id = typeof payload.sub === "string" ? payload.sub : null;
    if (!id) return null;
    return (await 是运营账号(id)) ? id : null;
  } catch {
    return null;
  }
}

/** 运营台票的 cookie 要不要 Secure：和登录会话同一个口径（lib/auth.ts 的 COOKIE_SECURE） */
export const 票要HTTPS = () =>
  process.env.COOKIE_SECURE === "true" || (process.env.COOKIE_SECURE === undefined && process.env.NODE_ENV === "production");

/**
 * 这一次请求带的运营台票是谁的（没有就 null）。页面和动作的门都走它。
 * 读 cookie 可能抛（不在请求里调用时，比如单测直接调动作）——抛了就当没有票，**不是放行**。
 */
export async function 当前运营账号(): Promise<string | null> {
  try {
    const { cookies } = await import("next/headers");
    return await 认运营票((await cookies()).get(运营COOKIE)?.value);
  } catch {
    return null;
  }
}
