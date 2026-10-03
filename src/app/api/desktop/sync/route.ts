import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { 归属对不上, 读 as 读云端凭据 } from "@/lib/desktop/cloud";
import { 读团队, 同步一轮 } from "@/lib/sync/client";

export const dynamic = "force-dynamic";

/**
 * 桌面端的壳每 30 秒、切回应用时戳一下：同步一轮（2026-10-03 团队同步）。
 * 门和 /api/desktop/reminders 一样：只认壳启动本地服务时现生成的那枚令牌，不走会话 cookie（窗口关了也要同步）。
 * 没加入团队、没登录、目录不是这个账号的：什么都不做。
 */
export async function POST(req: Request) {
  const expected = process.env.DESKTOP_TOKEN;
  if (process.env.DESKTOP_LOCAL !== "1" || !expected) return new NextResponse("Not Found", { status: 404 });
  const a = Buffer.from(req.headers.get("x-desktop-token") ?? "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return new NextResponse("Forbidden", { status: 403 });
  if (归属对不上() || !读云端凭据() || !读团队()) return NextResponse.json({ ok: true, 跳过: true });
  return NextResponse.json(await 同步一轮());
}
