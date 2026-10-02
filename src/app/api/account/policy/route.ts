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
 * register 回答「还收不收新注册」。inApp 说这个云端有没有 /api/account/signup/*
 * （2026-10-02 加的）：老桌面端不认这个字段，照旧开浏览器；新桌面端碰上没部署新接口的云端，
 * 看不到 inApp 也照旧开浏览器——两边谁先升级都不会摆出一个点了报错的入口。
 *
 * 只回两个布尔值，不回任何配置细节：这是个**不需要凭证**就能调的接口。
 */
export async function GET() {
  if (!multiTenant()) return NextResponse.json({ error: "这个部署没有账号体系" }, { status: 404 });
  return NextResponse.json({
    register: !自助注册已关闭(),
    inApp: true,
    reset: 能找回密码(),
  });
}
