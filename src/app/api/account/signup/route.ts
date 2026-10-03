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

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  // 公网接口：字段类型不对回 400，别抛成 500（第六轮 C2）
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const 串 = (v: unknown) => v == null || typeof v === "string";
  if (!串(body.target) || !串(body.code) || !串(body.password)) {
    return NextResponse.json({ error: "请求格式不对" }, { status: 400 });
  }
  const r = await 注册账号(
    {
      target: (body.target as string | undefined) ?? "",
      code: body.code as string | undefined,
      password: (body.password as string | undefined) ?? "",
      agreed: body.agreed === true,
    },
    解析来源IP(req.headers.get("x-forwarded-for")),
  );
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
