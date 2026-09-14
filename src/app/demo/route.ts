import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { createSession } from "@/lib/auth";
import { multiTenant } from "@/lib/tenant/context";
import { 演示票据信息 } from "@/lib/demo/workspace";

export const dynamic = "force-dynamic";

/**
 * 演示入口：点一下就进去，不注册不登录。
 *
 * 这是全站唯一一个不校验密码就签发会话的地方，所以边界必须窄到没有歧义：
 * 目标工作区只能来自环境变量 DEMO_WORKSPACE，请求里的任何东西都不参与决定
 * 进哪个库。没配就是 404——自部署版不该凭空多出一个免登录入口。
 */
export async function GET(req: Request) {
  if (!multiTenant() || !process.env.DEMO_WORKSPACE) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const info = await 演示票据信息();
  if (!info) return new NextResponse("演示工作区还没建好", { status: 503 });

  await createSession(info.accountId, info.workspaceId);

  // 跳转用请求自身的 host，不写死域名：换域名时这里不该是第二个要改的地方
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? new URL(req.url).host;
  return NextResponse.redirect(`${proto}://${host}/dashboard`);
}
