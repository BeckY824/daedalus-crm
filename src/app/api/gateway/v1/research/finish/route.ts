import { NextResponse } from "next/server";
import { 网关认证, 网关错误 } from "@/lib/tenant/gateway-auth";
import { 收尾背调, 背调余额 } from "@/lib/tenant/credits";
import type { 收尾回应 } from "@/lib/research/types";
import { 读请求体, 认runId, 兜底 } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 收尾：记下桌面端报的结果（ok = 6 步跑完了；取消 = 用户自己停的），**退不退服务器自己判断**
 * （lib/tenant/credits.ts 的 收尾背调）：最后一步交没交出去、我们这边失败过没有，都是网关和搜索接口自己记的。
 *
 * 请求里的 searches / pages 不用：服务器自己数过（AiResearchRun），客户端报的只是它那边的口径，
 * 拿它覆盖服务器的数就等于让客户端自己填账。
 *
 * 桌面端能左右的只剩「取消」：报了就不退——谎报只会让它自己少退一次。
 * 想白拿材料的路（跳过最后一步再报没跑完）要有服务器记到的失败才退，见 收尾背调 第 5 条。
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
  if (读.body.取消 !== undefined && typeof 读.body.取消 !== "boolean") return 网关错误(400, "取消 要是 true 或 false");

  const owner = { kind: "account" as const, id: accountId };
  const r = await 收尾背调(owner, runId, 读.body.ok, 读.body.取消 === true);
  if (!r.有这笔) return 网关错误(404, "找不到这次背调");
  // 还剩的是背调次数（和问答的 AI 次数分开）
  const 还剩 = (await 背调余额(owner)).还剩;
  const 回应: 收尾回应 = { ok: true, 退了: r.退了, 还剩 };
  return NextResponse.json(回应);
}
