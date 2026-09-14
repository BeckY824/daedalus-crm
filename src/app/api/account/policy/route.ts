import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 自助注册已关闭, 需要验证码, 能收到码 } from "@/lib/tenant/signup-policy";
import { 能找回密码 } from "@/lib/tenant/password-reset";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 这个部署现在开着哪几条路。桌面端打开登录窗时问一次，据此决定画哪几个入口。
 *
 * 存在的理由是「别画一个填了就被拒的框」：桌面端不问的话，只能先让人把表单填完
 * 再拿服务端的报错去解释——而这三件事（注册开不开、要不要验证码、能不能自助找回）
 * 全都由服务端的环境变量决定，客户端无从得知。
 *
 * 只回三个布尔值，不回任何配置细节：这是个**不需要凭证**就能调的接口。
 */
export async function GET() {
  if (!multiTenant()) return NextResponse.json({ error: "这个部署没有账号体系" }, { status: 404 });
  return NextResponse.json({
    register: !自助注册已关闭(),
    // 要验证码但发不出码时，等于注册这条路也走不通，前面那个就该是 false
    verify: 需要验证码() && 能收到码(),
    reset: 能找回密码(),
  });
}
