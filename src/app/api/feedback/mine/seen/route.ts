import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { 本地模式 } from "@/lib/desktop/cloud";
import { 记已读 } from "@/lib/desktop/feedback";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 「我的反馈」里点开了一串：记下看到了哪一条回复（本机 feedback-seen.json，见 lib/desktop/feedback.ts）。
 * 只有桌面端本地服务有：已读只关这台电脑，不上云。
 */
export async function POST(req: Request) {
  await requireUser();
  if (!本地模式()) return new NextResponse("Not Found", { status: 404 });
  const raw = (await req.json().catch(() => ({}))) as { feedbackId?: unknown; messageId?: unknown };
  const feedbackId = typeof raw.feedbackId === "string" ? raw.feedbackId.slice(0, 64) : "";
  const messageId = typeof raw.messageId === "string" ? raw.messageId.slice(0, 64) : "";
  if (!feedbackId || !messageId) return NextResponse.json({ error: "缺 feedbackId / messageId" }, { status: 400 });
  记已读(feedbackId, messageId);
  return NextResponse.json({ ok: true });
}
