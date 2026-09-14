import { NextResponse } from "next/server";
import { 网关认证 } from "@/lib/tenant/gateway-auth";
import { 余额, 结算赠送, 每日赠送 } from "@/lib/tenant/credits";

export const dynamic = "force-dynamic";

/**
 * 还剩几次。不是 OpenAI 的接口，是桌面端用来显示额度的。
 * 顺带把当天的赠送结掉——用户打开应用看一眼额度，就算"今天用了"。
 */
export async function GET(req: Request) {
  const auth = await 网关认证(req);
  if (!auth.ok) return auth.res;
  const owner = { kind: "account" as const, id: auth.accountId };
  await 结算赠送(owner);
  return NextResponse.json({ ...(await 余额(owner)), 每日赠送 });
}
