import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 认领, 取Bearer } from "@/lib/tenant/device-token";
import { 是运营账号, 运营名单 } from "@/lib/ops-auth";

export const dynamic = "force-dynamic";

/**
 * 桌面端的壳问：「登录着的这个账号能开运营台吗」。能，菜单里才出现「运营台…」。
 * 不是托管版、或者没配运营名单：404，当这条路不存在。令牌不认：401。其余一律 200 + ok 真假——
 * 不区分「不在名单」和「名单里没这种人」，免得它成了一个查谁是运营的接口。
 */
export async function GET(req: Request) {
  if (!multiTenant() || 运营名单().length === 0) return new NextResponse("Not Found", { status: 404 });
  const who = await 认领(取Bearer(req));
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: await 是运营账号(who.accountId) });
}
