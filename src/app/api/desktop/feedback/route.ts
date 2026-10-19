import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { 取我的反馈 } from "@/lib/desktop/feedback";
import { 最后一条回复 } from "@/lib/feedback-unread";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 桌面端的壳每几分钟问一次：有没有我们回了、这台电脑还没看过的反馈（desktop/feedback-replies.js 据此弹系统通知）。
 *
 * **只有壳能问**：和 /api/desktop/reminders 同一把钥匙（DESKTOP_TOKEN，只在父子进程的环境变量里）。
 * 窗口关了壳照样要问——Mac 上关了窗口应用还在 Dock 里，Windows 收进托盘也还在——那时没有页面、没有 cookie。
 *
 * 只回没看过的那几条，每条带最后一条回复的 id、时间和正文：壳按回复 id 记「提醒过了」，同一句不叫第二次。
 */
export async function GET(req: Request) {
  const expected = process.env.DESKTOP_TOKEN;
  if (process.env.DESKTOP_LOCAL !== "1" || !expected) return new NextResponse("Not Found", { status: 404 });
  const a = Buffer.from(req.headers.get("x-desktop-token") ?? "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return new NextResponse("Forbidden", { status: 403 });

  const r = await 取我的反馈({ 新: true });
  const 未读 = r.反馈
    .filter((f) => f.未读)
    .map((f) => {
      const 回 = 最后一条回复(f)!;
      return { feedbackId: f.id, 回复id: 回.id, at: 回.at, 回复: 回.body };
    });
  return NextResponse.json({ 可用: r.可用, 未读 });
}
