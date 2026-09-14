import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 发送重置码 } from "@/lib/tenant/password-reset";
import { 解析来源IP } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 发一封**找回密码**的验证码邮件。桌面端那个窗口用它。
 *
 * 只有这一种用途。注册用的码不从这里发——注册整个在网页上办
 * （桌面端的「注册新账号」是开浏览器，理由见 desktop/main.js 顶部），
 * 而注册那条路的发码行为和这条**故意相反**：那边会直说「这个号已经注册过了」，
 * 这边不存在的号也返回同一句成功。两种语义共用一个口子，迟早有人改错一边。
 *
 * 规则在 lib/tenant/password-reset.ts，和网页 /forgot 共用一份实现，
 * 这里只负责把来源 IP 取出来。
 */
export async function POST(req: Request) {
  if (!multiTenant()) return NextResponse.json({ error: "这个部署没有账号体系" }, { status: 404 });

  let body: { target?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const target = (body.target ?? "").trim();
  if (!target) return NextResponse.json({ error: "请填邮箱" }, { status: 400 });

  const r = await 发送重置码(target, 解析来源IP(req.headers.get("x-forwarded-for")));
  // 这里的失败全是「你填得不对 / 你太频繁了」，不是服务器出错，用 400 而不是 500
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true, hint: r.hint });
}
