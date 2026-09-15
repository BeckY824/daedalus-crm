import { NextResponse } from "next/server";
import { version } from "../../../../package.json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 探活。给监控和发版脚本用：起来了就 200，附带版本号，好确认 pull 的镜像真的换了。
 *
 * 故意不碰数据库、不看登录态、不报任何配置——这是个不需要凭证就能打的接口，
 * 多回一个字段就多一分被人当探针用的可能。库坏了该由日志和业务接口暴露，不在这里。
 */
export async function GET() {
  return NextResponse.json({ ok: true, version }, { headers: { "Cache-Control": "no-store" } });
}
