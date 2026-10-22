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
 * register 回答「还收不收新注册」，reset 回答「能不能自助找回密码」。inApp 说这个云端有没有
 * /api/account/signup/*（2026-10-02 加的），老桌面端不认这个字段，照旧开浏览器去网页注册。
 *
 * 桌面端只认**明说的 false**（2026-10-21 P0，lib/desktop/cloud.ts 的 策略()）：哪个字段没回、
 * 这个接口没回好（超时、4xx、5xx、回的不是 JSON），一律当开着，把入口照常摆出来。
 * 所以这里要藏哪个入口就必须明明白白回 false，不能靠不回那个字段。
 *
 * 只回三个布尔值，不回任何配置细节：这是个**不需要凭证**就能调的接口。
 * 专属服务器（桌面端登录页「使用专属服务器」）连之前也问这一条，认 register 是不是布尔值。
 */
export async function GET() {
  if (!multiTenant()) return NextResponse.json({ error: "这个部署没有账号体系" }, { status: 404 });
  return NextResponse.json({
    register: !自助注册已关闭(),
    inApp: true,
    reset: 能找回密码(),
  });
}
