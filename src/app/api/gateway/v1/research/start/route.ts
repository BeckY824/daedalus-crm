import { NextResponse } from "next/server";
import { 网关认证, 网关错误 } from "@/lib/tenant/gateway-auth";
import { 按背调扣, 注册赠送发过吗, 余额 } from "@/lib/tenant/credits";
import { consumeAiQuota } from "@/lib/ai-quota";
import { 记下背调 } from "@/lib/research/runs-memory";
import { 背调模型表 } from "@/lib/gateway";
import type { 开始回应 } from "@/lib/research/types";
import { 背调扣次 } from "@/lib/research/price";
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
  /*
    10-16 总控定：背调的搜索和分析一律走我们的服务器、用我们的 Key，**填了自己模型 Key 的也照价扣**——不能白用。
    老客户端会带 走我们的模型: false，不看它
  */
  const 走我们的模型 = true;

  // 和模型网关分开计数：背调一次几分钟，一个人五分钟里开三十次就不是在正常用了
  const 等 = consumeAiQuota(`rs:${accountId}`);
  if (等 !== null) return 网关错误(429, `请求太频繁，请 ${等} 秒后再试`);

  const owner = { kind: "account" as const, id: accountId };
  const units = 背调扣次();
  const r = await 按背调扣(owner, runId, units, 走我们的模型);
  if (!r.ok) {
    const 还剩 = (await 余额(owner)).还剩;
    const 要几次 = `背调要 ${units} 次，你还剩 ${还剩} 次`;
    // 措辞和模型网关的 402 对齐（api/gateway/v1/chat/completions）：没领到开户赠送的要说清楚为什么
    if (!(await 注册赠送发过吗(owner)) && r.上限 === 0) {
      return 网关错误(402, `${要几次}。免费 AI 次数一台电脑只送一份，这台电脑上已经有别的账号领过了。`);
    }
    // 次数包先由运营台手动加（和团队版开通一样）：这里只说清楚差多少，不指路去填 Key——填了 Key 背调也照扣
    return 网关错误(402, `${要几次}，这次没扣。需要加次数请联系我们。`, { "X-Credits-Remaining": String(还剩) });
  }
  记下背调(accountId, runId);
  // 背调用哪个模型由我们定（lib/gateway.ts 背调模型表）：客户端能点名就等于能点我们的账单
  const 回应: 开始回应 = { ok: true, 扣了: r.扣了, 还剩: r.还剩, 模型: 背调模型表()[0] };
  return NextResponse.json(回应, { headers: { "X-Credits-Remaining": String(r.还剩) } });
}
