import { NextResponse } from "next/server";
import { 网关认证, 网关错误 } from "@/lib/tenant/gateway-auth";
import { 按背调扣 } from "@/lib/tenant/credits";
import { consumeAiQuota } from "@/lib/ai-quota";
import { 记下背调 } from "@/lib/research/runs-memory";
import type { 开始回应 } from "@/lib/research/types";
import { 背调模型们, 搜索上限 } from "@/lib/research/price";
import { 读请求体, 认runId, 兜底 } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 开始一次背调：按整笔扣次数（lib/tenant/credits.ts 的 按背调扣）。
 *
 * 扣在最前面、一次扣足，和模型网关「在转发之前扣」一个道理：限的是发起，不是成功。
 * 后面的搜索 / 读页认的就是这一笔——没扣过的 runId 搜不了、读不了。
 * 同一个 runId 重发 start 不会重扣（桌面端网络抖一下重试是常事）。
 */
export async function POST(req: Request) {
  try {
    return await 处理(req);
  } catch (e) {
    return 兜底("start", e);
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
  // 背调的搜索和分析一律走我们的服务器、用我们的 Key，填了自己模型 Key 的也照扣（10-16 总控定）。老客户端会带 走我们的模型: false，不看它

  // 和模型网关分开计数：背调一次几分钟，一个人五分钟里开三十次就不是在正常用了
  const 等 = consumeAiQuota(`rs:${accountId}`);
  if (等 !== null) return 网关错误(429, `请求太频繁，请 ${等} 秒后再试`);

  const owner = { kind: "account" as const, id: accountId };
  // 扣的是背调次数（和问答的 AI 次数分开，一次 1 次），见 lib/tenant/credits.ts 的 按背调扣
  const r = await 按背调扣(owner, runId);
  if (!r.ok) {
    // 加次数先由运营台手动加（和团队版开通一样，没有购买页）：这里只说清楚差多少
    return 网关错误(402, `背调次数用完了：一次背调扣 1 次，你还剩 ${r.还剩} 次背调。需要加次数请联系我们。`);
  }
  记下背调(accountId, runId);
  // 用哪个模型由我们定（lib/research/price.ts 背调模型们）：客户端能点名就等于能点我们的账单
  const 模型们 = 背调模型们();
  const 回应: 开始回应 = { ok: true, 扣了: r.扣了, 还剩: r.还剩, 模型: 模型们.报告, 摘要模型: 模型们.摘要, 搜索上限: 搜索上限() };
  return NextResponse.json(回应);
}
