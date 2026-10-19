import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { 归属对不上, 读 as 读云端凭据 } from "@/lib/desktop/cloud";
import { prisma } from "@/lib/prisma";
import { 读团队, 同步一轮 } from "@/lib/sync/client";
import { 同事新建提醒 } from "@/lib/sync/team-notice";

export const dynamic = "force-dynamic";

/**
 * 桌面端的壳每 30 秒、切回应用时戳一下：同步一轮（2026-10-03 团队同步）。
 * 门和 /api/desktop/reminders 一样：只认壳启动本地服务时现生成的那枚令牌，不走会话 cookie（窗口关了也要同步）。
 * 没加入团队、没登录、目录不是这个账号的：什么都不做。
 * 老板那台：这一轮（和上一次问之后「改完推一下」那几轮）收到的同事新建的客户 / 商机 / 跟进，放在 同事新建 里交给壳发提醒
 *（lib/sync/team-notice.ts、desktop/team-notices.js）。筛不出东西就不带这一项。
 */
export async function POST(req: Request) {
  const expected = process.env.DESKTOP_TOKEN;
  if (process.env.DESKTOP_LOCAL !== "1" || !expected) return new NextResponse("Not Found", { status: 404 });
  const a = Buffer.from(req.headers.get("x-desktop-token") ?? "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return new NextResponse("Forbidden", { status: 403 });
  if (归属对不上() || !读云端凭据() || !读团队()) return NextResponse.json({ ok: true, 跳过: true });
  const r = await 同步一轮();
  // 提醒出了错不能拖垮同步：只是这一次不提醒
  const 同事新建 = await 同事新建提醒(prisma, 读团队()).catch(() => []);
  return NextResponse.json(同事新建.length ? { ...r, 同事新建 } : r);
}
