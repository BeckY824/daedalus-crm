import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 重置密码 } from "@/lib/tenant/password-reset";
import { 解析来源IP } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 用验证码把密码改掉。桌面端的「忘记密码」走这里，规则和网页 /forgot 是同一份
 * （lib/tenant/password-reset.ts）。
 *
 * **改密码 = 到处都要重新登录**：网页会话作废，桌面端那几枚设备令牌也一起吊掉。
 *
 * 这条 2026-09-17 改过。原来只作废网页会话、不碰设备令牌，理由写的是
 * 「令牌是另一类凭证，它自己有列出与吊销的口子」——可那个口子当时只有两个函数，
 * 界面上一处都没有。于是机器丢了的人只剩「改密码」这一根杠杆，而那根杠杆
 * 对令牌不起作用，唯一的吊销方式在那台丢了的机器上：等于没有退路。
 * 「手上几台机器都要重登一次」是真实代价，但它在改密码那一屏上写明白了，
 * 而且和人对「我改了密码」的预期一致。要只退一台的，同一天补了设置页的
 * 「已登录的机器」那一栏（settings/actions.ts 的 退出这台机器）。
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
