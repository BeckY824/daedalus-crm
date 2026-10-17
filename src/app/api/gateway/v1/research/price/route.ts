import { NextResponse } from "next/server";
import { 网关认证 } from "@/lib/tenant/gateway-auth";
import { 背调余额, 背调每次 } from "@/lib/tenant/credits";
import type { 价目回应 } from "@/lib/research/types";
import { 兜底 } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 开跑前问价：一次背调扣几次背调次数（1）、这个账号还剩几次背调。背调次数和问答的 AI 次数分开记（10-16 用户定），
 * 桌面端的背调模式按钮靠它写「背调 · 剩 N 次」，没次数就发不出去。
 * 只读：不扣、不记。
 */
export async function GET(req: Request) {
  try {
    const auth = await 网关认证(req);
    if (!auth.ok) return auth.res;
    const r = await 背调余额({ kind: "account", id: auth.accountId });
    const 回应: 价目回应 = { 扣次: 背调每次, 还剩: r.还剩, ...(r.不限 ? { 不限: true as const } : {}) };
    return NextResponse.json(回应);
  } catch (e) {
    return 兜底("price", e);
  }
}
