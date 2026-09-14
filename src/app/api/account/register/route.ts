import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 注册账号 } from "@/lib/tenant/register-account";
import { 签发 } from "@/lib/tenant/device-token";
import { 余额 } from "@/lib/tenant/credits";
import { 解析来源IP } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 桌面端注册：邮箱 + 密码（+ 需要时的验证码）→ 一个账号，外加一枚设备令牌。
 *
 * **不开工作区。** 桌面端的数据在用户自己机器上，云端只管账号和模型网关；
 * 给每个桌面用户在服务器上建一个永远空着的库，既费地方又和本地优先的方向相反。
 * 免费次数因此按账号记，规则见 tenant/credits.ts。
 *
 * 注册完直接把令牌发回去，省掉「注册成功，请再登录一次」那一步——
 * 密码刚刚是他自己设的，再验一遍不增加任何确定性。
 * 返回结构和 /api/account/token 一模一样，桌面端两条路共用同一段处理。
 */
export async function POST(req: Request) {
  if (!multiTenant()) return NextResponse.json({ error: "这个部署没有账号体系" }, { status: 404 });

  let body: { target?: string; password?: string; code?: string; name?: string; device?: string; agreed?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const r = await 注册账号(
    {
      target: (body.target ?? "").trim(),
      password: body.password ?? "",
      code: body.code,
      name: body.name,
      agreed: body.agreed,
    },
    解析来源IP(req.headers.get("x-forwarded-for")),
  );
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });

  const { token } = await 签发(r.account.id, body.device?.trim() || "桌面端");
  return NextResponse.json({
    token,
    account: { name: r.account.name, contact: r.account.phone ?? r.account.email ?? "" },
    credits: await 余额({ kind: "account", id: r.account.id }),
  });
}
