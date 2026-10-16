import { NextResponse } from "next/server";
import { 网关认证, 网关错误 } from "@/lib/tenant/gateway-auth";
import { 收尾背调, 背调余额 } from "@/lib/tenant/credits";
import type { 收尾回应 } from "@/lib/research/types";
import { 读请求体, 认runId, 兜底 } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 收尾：出了报告（ok=true）只记账；没出报告（ok=false）整笔退（lib/tenant/credits.ts 的 收尾背调）。
 *
 * 请求里的 searches / pages 不用：服务器自己数过（AiResearchRun），客户端报的只是它那边的口径，
 * 拿它覆盖服务器的数就等于让客户端自己填账。
 *
 * 退不退由桌面端说了算，这是一个已知的口子：改过的客户端可以每次都报「没出报告」，白拿搜索和读页。
 * 能用的程度被 start 的频率闸（五分钟 30 次）和每次背调的次数闸压着；真被这么用了，
 * 运营台按 AiResearchRun 里 refunded = 1 且 searches 很多的行一查就看得出来。
 */
export async function POST(req: Request) {
  try {
    return await 处理(req);
  } catch (e) {
    return 兜底("finish", e);
  }
}

async function 处理(req: Request) {
  const auth = await 网关认证(req);
  if (!auth.ok) return auth.res;
  const { accountId } = auth;
  const 读 = await 读请求体(req);
  if (!读.ok) return 读.res;
  const runId = 认runId(读.body);
  if (!runId) return 网关错误(400, "runId 不对：要 1–64 位字母、数字、- 或 _");
  if (typeof 读.body.ok !== "boolean") return 网关错误(400, "ok 要是 true 或 false");

  const owner = { kind: "account" as const, id: accountId };
  const r = await 收尾背调(owner, runId, 读.body.ok);
  if (!r.有这笔) return 网关错误(404, "找不到这次背调");
  // 还剩的是背调次数（和问答的 AI 次数分开）
  const 还剩 = (await 背调余额(owner)).还剩;
  const 回应: 收尾回应 = { ok: true, 退了: r.退了, 还剩 };
  return NextResponse.json(回应);
}
