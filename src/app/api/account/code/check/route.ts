import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { checkCode, parseTarget } from "@/lib/tenant/accounts";
import { 检查限流, 记一次失败, IP阈值, 解析来源IP } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 输码那一步填满 6 位时先核对一下（2026-10-03）：只核对、不用掉，错的照样算一次（lib/tenant/accounts.ts 的 checkCode）。
 * 注册（purpose = signup）和找回密码（purpose = reset）共用。按来源 IP 再限一档，和注册、改密码那两条一样。
 * 云端没有这个接口（老版本）时桌面端拿到 404，就照旧先去设密码、最后再一起验——见 lib/desktop/cloud.ts 的 核对验证码
 */
export async function POST(req: Request) {
  if (!multiTenant()) return NextResponse.json({ error: "这个部署没有账号体系" }, { status: 404 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (typeof body.target !== "string" || typeof body.code !== "string" || (body.purpose !== "signup" && body.purpose !== "reset")) {
    return NextResponse.json({ error: "请求格式不对" }, { status: 400 });
  }
  const t = parseTarget(body.target.trim());
  if (!t) return NextResponse.json({ error: "请填正确的邮箱" }, { status: 400 });

  const from = 解析来源IP(req.headers.get("x-forwarded-for"));
  if (from) {
    const 还要等 = 检查限流(`codecheck:${from}`);
    if (还要等 != null) return NextResponse.json({ error: `操作太频繁，请 ${还要等} 秒后再试` }, { status: 400 });
  }
  const r = await checkCode(t.value, body.code, body.purpose);
  if (!r.ok) {
    if (from) 记一次失败(`codecheck:${from}`, Date.now(), IP阈值);
    return NextResponse.json({ error: r.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
