import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 认领, 取Bearer } from "@/lib/tenant/device-token";
import { 发进门码, 是运营账号, 运营名单 } from "@/lib/ops-auth";

export const dynamic = "force-dynamic";

/**
 * 壳拿设备令牌换一枚一次性进门码，然后在新窗口里打开 /admin/enter?code=…。
 * 码 60 秒过期、用一次就作废——它会出现在一个网址里，所以不能是一张长期有效的票。
 */
export async function POST(req: Request) {
  if (!multiTenant() || 运营名单().length === 0) return new NextResponse("Not Found", { status: 404 });
  const who = await 认领(取Bearer(req));
  if (!who) return NextResponse.json({ error: "设备令牌无效或已被吊销" }, { status: 401 });
  if (!(await 是运营账号(who.accountId))) return NextResponse.json({ error: "这个账号不能打开运营台" }, { status: 403 });
  return NextResponse.json({ path: `/admin/enter?code=${发进门码(who.accountId)}` });
}
