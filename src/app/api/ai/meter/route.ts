import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { 读AI计次 } from "@/lib/ai-meter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 还剩几次免费 AI（lib/ai-meter.ts）。浏览器在页面出来之后、以及每答完一次之后问一下。
 *
 * 为什么不放进布局一起算：桌面端的余额要去云端问，断网时最多等 6 秒——
 * 让一行「还剩 N 次」把整页拖住是本末倒置。
 */
export async function GET() {
  if (!(await getCurrentUser())) return NextResponse.json({ error: "未登录" }, { status: 401 });
  return NextResponse.json(await 读AI计次({ 问余额: true }));
}
