import { randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * MCP 接入令牌。
 *
 * 别人的 agent（Claude Code / Codex / Claude 桌面端）连进来时拿它当身份，
 * 所以它**不是**桌面端那枚 DESKTOP_TOKEN：那枚能换一个登录会话，
 * 而这枚只能调只读工具。两件事混在一把钥匙上，等于把整个应用的门也一起交出去。
 *
 * 一个库一把，存在 Setting 里（和 AI 配置同一张表）。
 * 记着是谁生成的：工具里「我负责的客户」「我的跟进计划」要按人算。
 * 重新生成一次，旧的立刻失效——钥匙抄给了不该给的人时只有这一条路。
 */

const KEY = "mcpToken";

export type Mcp令牌 = { token: string; userId: string; createdAt: string };

export async function 读令牌(): Promise<Mcp令牌 | null> {
  const v = await getSetting<Mcp令牌>(KEY);
  if (!v || typeof v.token !== "string" || typeof v.userId !== "string") return null;
  return v;
}

export async function 生成令牌(userId: string): Promise<Mcp令牌> {
  const v: Mcp令牌 = { token: `dcrm_${randomBytes(24).toString("base64url")}`, userId, createdAt: new Date().toISOString() };
  await setSetting(KEY, v);
  return v;
}

export async function 撤销令牌(): Promise<void> {
  await setSetting(KEY, null);
}

/**
 * 拿着一个 token 换「这是谁」。
 *
 * 比对用 timingSafeEqual：普通的 `===` 会在第一个不同的字节上就返回，
 * 逐字节试出一把令牌在本机接口上是做得到的。
 * 生成令牌的那个人被停用之后，这把钥匙一起作废——他已经不该有权限了。
 */
export async function 认令牌(给的: string | null | undefined): Promise<{ id: string; name: string } | null> {
  if (!给的) return null;
  const 存的 = await 读令牌();
  if (!存的) return null;
  const a = Buffer.from(给的);
  const b = Buffer.from(存的.token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const u = await prisma.user.findFirst({ where: { id: 存的.userId, active: true }, select: { id: true, name: true } });
  return u ?? null;
}
