import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 重置密码 } from "@/lib/tenant/password-reset";
import { 解析来源IP } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 用验证码把密码改掉。桌面端的「忘记密码」走这里，规则和网页 /forgot 是同一份
 * （lib/tenant/password-reset.ts），包括「改完之后旧会话全部作废」。
 *
 * 注意改完密码**不会**顺手把设备令牌吊销掉。那是刻意的：令牌是另一类凭证
 * （像应用专用密码），它自己有列出与吊销的口子；把它绑进改密里，
 * 会变成「在网页上改个密码，手上三台机器的 AI 全断了」而没人知道为什么。
 */
export async function POST(req: Request) {
  if (!multiTenant()) return NextResponse.json({ error: "这个部署没有账号体系" }, { status: 404 });

  let body: { target?: string; code?: string; password?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const r = await 重置密码(
    { target: (body.target ?? "").trim(), code: (body.code ?? "").trim(), password: body.password ?? "" },
    解析来源IP(req.headers.get("x-forwarded-for")),
  );
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
