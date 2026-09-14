import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 发送注册码 } from "@/lib/tenant/register-account";
import { 发送重置码 } from "@/lib/tenant/password-reset";
import { 解析来源IP } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 发一封验证码邮件。注册用和找回密码用共走这一个口，靠 purpose 分。
 *
 * 两种用途的行为**故意不一样**，别看着像就合并：
 *   signup —— 会直说「这个号已经注册过了」。那不是泄露，是注册该给的指路。
 *   reset  —— 不存在的号也返回同一句成功。区分开的话它就成了查号接口。
 * 规则各自在 tenant/register-account.ts 和 tenant/password-reset.ts 里，
 * 和网页那两条路共用同一份实现，这里只负责把来源 IP 取出来。
 */
export async function POST(req: Request) {
  if (!multiTenant()) return NextResponse.json({ error: "这个部署没有账号体系" }, { status: 404 });

  let body: { target?: string; purpose?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const target = (body.target ?? "").trim();
  if (!target) return NextResponse.json({ error: "请填邮箱" }, { status: 400 });
  const purpose = body.purpose === "reset" ? "reset" : "signup";

  const from = 解析来源IP(req.headers.get("x-forwarded-for"));
  const r = purpose === "reset" ? await 发送重置码(target, from) : await 发送注册码(target, from);
  // 这里的失败全是「你填得不对 / 你太频繁了」，不是服务器出错，用 400 而不是 500
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true, hint: r.hint });
}
