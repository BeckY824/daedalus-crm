import { NextResponse } from "next/server";
import { 网关认证 } from "@/lib/tenant/gateway-auth";
import { 余额 } from "@/lib/tenant/credits";
import { 背调扣次 } from "@/lib/research/price";
import type { 价目回应 } from "@/lib/research/types";
import { 兜底 } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 开跑前问价：一次背调扣几次、这个账号还剩几次。桌面端的确认卡靠它说「背调要 60 次，你还剩 N 次」，
 * 不够就不让开始。扣几次是服务器的配置（AI_PRICE_TABLE），桌面端不写死——改价不用等发版。
 * 只读：不扣、不记。
 */
export async function GET(req: Request) {
  try {
    const auth = await 网关认证(req);
    if (!auth.ok) return auth.res;
    const r = await 余额({ kind: "account", id: auth.accountId });
    const 回应: 价目回应 = { 扣次: 背调扣次(), 还剩: r.还剩, ...(r.不限 ? { 不限: true as const } : {}) };
    return NextResponse.json(回应);
  } catch (e) {
    return 兜底("price", e);
  }
}
