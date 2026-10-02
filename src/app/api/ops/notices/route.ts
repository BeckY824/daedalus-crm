import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 认领, 取Bearer } from "@/lib/tenant/device-token";
import { 是运营账号, 运营名单 } from "@/lib/ops-auth";
import { 读运营通知 } from "@/lib/ops-notices";

export const dynamic = "force-dynamic";

/**
 * 运营通知（lib/ops-notices.ts）：壳拿设备令牌问「since 以来运营台有什么事」。
 * 门和 /api/ops/enter 同一道：不是托管版、没配名单 404；令牌不认 401；**不是运营账号 403、一个字都不给**——
 * 新注册的邮箱、别人的反馈原话，只有运营本人的那台桌面端能拿到。
 */
export async function GET(req: Request) {
  if (!multiTenant() || 运营名单().length === 0) return new NextResponse("Not Found", { status: 404 });
  const who = await 认领(取Bearer(req));
  if (!who) return NextResponse.json({ error: "设备令牌无效或已被吊销" }, { status: 401 });
  if (!(await 是运营账号(who.accountId))) return NextResponse.json({ error: "无权查看" }, { status: 403 });
  return NextResponse.json(await 读运营通知(new URL(req.url).searchParams.get("since")));
}
