import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 需要验证码, 自助注册已关闭 } from "@/lib/tenant/signup-policy";
import { 发注册码, 识别注册账号 } from "@/lib/tenant/signup";
import { 解析来源IP } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 桌面端登录页的第一步：填了个邮箱，点「继续」。这里回答该往哪走。
 *
 *   409 { registered: true }  已经注册过 → 桌面端带人去输密码
 *   200 { verify: true }      码发出去了 → 输验证码
 *   200 { verify: false }     这个部署不验证码 → 直接设密码
 *   400 { error }             填得不对、临时邮箱、太频繁、没开放注册
 *
 * 「已经注册过」会被说出来，和网页 /signup 的发码一样，是注册页该给的指路
 * （见 lib/tenant/signup.ts 发注册码 上面那段），网页那边一直就这么回，这里没有多露什么。
 * 不验证码那条路也要先查一次号，否则老用户填完邮箱会被带去「设密码」。
 */
export async function POST(req: Request) {
  if (!multiTenant()) return NextResponse.json({ error: "这个部署没有账号体系" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  // 公网接口：字段类型不对（null、数字、数组）回 400，别让它在 .trim() 上抛成 500（第六轮 C2）
  const 原 = (body as { target?: unknown } | null)?.target;
  if (原 != null && typeof 原 !== "string") return NextResponse.json({ error: "请填邮箱" }, { status: 400 });
  const target = (原 ?? "").trim();
  if (!target) return NextResponse.json({ error: "请填邮箱" }, { status: 400 });

  const ip = 解析来源IP(req.headers.get("x-forwarded-for"));
  if (!需要验证码()) {
    const r = await 识别注册账号(target, ip);
    if (!r.ok) return NextResponse.json(r.已注册 ? { registered: true } : { error: r.error }, { status: r.已注册 ? 409 : 400 });
    if (自助注册已关闭()) return NextResponse.json({ error: "这个部署没有开放注册" }, { status: 400 });
    return NextResponse.json({ verify: false });
  }

  const r = await 发注册码(target, ip);
  if (!r.ok) {
    if (r.已注册) return NextResponse.json({ registered: true }, { status: 409 });
    return NextResponse.json({ error: r.error }, { status: 400 });
  }
  return NextResponse.json({ verify: true, hint: r.hint });
}
