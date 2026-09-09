import { NextResponse } from "next/server";
import { generateBrief } from "@/app/(app)/customers/[id]/ai";

/**
 * 记录页 AI 面板走这条路由而不是 Server Action。
 * 原因：Next 会把同一客户端的 Server Action 串行排队，简报一次要十几秒，
 * 期间用户点「登记签约」「直接记」都会被排在它后面等——界面像卡死了一样。
 * 普通 fetch 不进那个队列。鉴权、配额、留痕都在 generateBrief 里，这里只是换个入口。
 */
export async function POST(req: Request) {
  let body: { customerId?: unknown; question?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求格式不对" }, { status: 400 });
  }
  if (typeof body.customerId !== "string") return NextResponse.json({ ok: false, error: "缺少 customerId" }, { status: 400 });
  const res = await generateBrief({ customerId: body.customerId, question: typeof body.question === "string" ? body.question : undefined });
  return NextResponse.json(res);
}
