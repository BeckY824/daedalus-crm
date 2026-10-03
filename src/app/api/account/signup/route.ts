import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 注册账号 } from "@/lib/tenant/signup";
import { 解析来源IP } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 桌面端在应用里注册：邮箱 +（要的话）验证码 + 密码 + 同意条款 → 开一个云端账号。
 *
 * 和网页 /signup 是同一份规则（lib/tenant/signup.ts）。只开账号，不发令牌：
 * 桌面端紧接着拿同一套邮箱密码去 /api/account/token 登录，
 * 注册赠送也在那一下按机器结算（理由见 lib/tenant/signup.ts 末尾那段）。
 */
export async function POST(req: Request) {
  if (!multiTenant()) return NextResponse.json({ error: "这个部署没有账号体系" }, { status: 404 });

  let body: { target?: string; code?: string; password?: string; agreed?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const r = await 注册账号(
    { target: body.target ?? "", code: body.code, password: body.password ?? "", agreed: body.agreed === true },
    解析来源IP(req.headers.get("x-forwarded-for")),
  );
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
