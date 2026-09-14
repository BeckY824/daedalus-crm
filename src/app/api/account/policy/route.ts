import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 自助注册已关闭 } from "@/lib/tenant/signup-policy";
import { 能找回密码 } from "@/lib/tenant/password-reset";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 这个部署开着哪两条路。桌面端打开登录窗时问一次，据此决定画哪几个入口。
 *
 * 存在的理由是「别摆一个点进去说没开放的链接」：这两件事都由服务端的环境变量
 * 决定，客户端无从得知，不问就只能等人点了再拿报错去解释。
 *
 * 注册不在这里办——桌面端那个链接是开浏览器去网页注册的，理由见 desktop/main.js。
 * 这里的 register 只回答「网页那边还收不收新注册」。
 *
 * 只回两个布尔值，不回任何配置细节：这是个**不需要凭证**就能调的接口。
 */
export async function GET() {
  if (!multiTenant()) return NextResponse.json({ error: "这个部署没有账号体系" }, { status: 404 });
  return NextResponse.json({
    register: !自助注册已关闭(),
    reset: 能找回密码(),
  });
}
