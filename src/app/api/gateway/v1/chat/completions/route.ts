import { NextResponse } from "next/server";
import { 网关认证, 网关错误 } from "@/lib/tenant/gateway-auth";
import { 收拾请求体 } from "@/lib/gateway";
import { 扣一次 } from "@/lib/tenant/credits";
import { consumeAiQuota } from "@/lib/ai-quota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 模型网关。对外是标准的 OpenAI 兼容接口，对内按账号扣免费次数再转发给上游。
 *
 * 桌面端把数据留在用户自己机器上，唯一还需要云端的就是这个——用户没有自己的 Key，
 * 我们替他转发。桌面端的 AI 设置因此就是「接口地址填我们、Key 填设备令牌」，
 * 和用户自己填 DeepSeek Key 走的是同一条代码路径。
 *
 * 三道闸，顺序有讲究：
 *   1. 令牌 —— 认不出直接 401，不碰账本也不碰上游
 *   2. 频率 —— 内存滑动窗口，防的是失控的循环脚本，不是恶意（和 ai-quota 同一套）
 *   3. 额度 —— **在转发之前扣**。失败的那次也算：限的是"发起"而不是"成功"，
 *      否则一个反复失败的请求可以无限重试，而每次重试都是真金白银的上游调用
 */
export async function POST(req: Request) {
  const auth = await 网关认证(req);
  if (!auth.ok) return auth.res;
  const { cfg, accountId } = auth;

  const 等 = consumeAiQuota(`gw:${accountId}`);
  if (等 !== null) return 网关错误(429, `请求太频繁，请 ${等} 秒后再试`);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return 网关错误(400, "请求体不是合法 JSON");
  }
  const 整理 = 收拾请求体((raw ?? {}) as Record<string, unknown>, cfg);
  if (!整理.ok) return 网关错误(400, 整理.error);

  const owner = { kind: "account" as const, id: accountId };
  const 扣 = await 扣一次(owner);
  if (!扣.ok) {
    return 网关错误(
      402,
      `免费的 AI 次数已经用完（共 ${扣.上限} 次），明天登录再送几次。也可以在设置里填自己的模型 API Key，那样不走我们的额度。`,
    );
  }

  const 剩余头 = { "X-Credits-Remaining": String(扣.还剩) };

  let upstream: Response;
  try {
    upstream = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(整理.body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    const 超时 = e instanceof Error && e.name === "TimeoutError";
    return 网关错误(504, 超时 ? "上游模型接口超时" : "连不上上游模型接口", 剩余头);
  }

  if (!upstream.ok) {
    // 上游的报错原样带回去（截断），但**不带上游的响应头**——那里可能有它的限流、
    // 计费一类的信息，那是我们和上游之间的事，不该让客户端看见
    const text = (await upstream.text()).slice(0, 500);
    return 网关错误(upstream.status, `上游模型接口返回 ${upstream.status}：${text}`, 剩余头);
  }

  // 流式：直接把上游的流接出去，不缓冲——缓冲了就没有"逐字出现"这回事了
  if (整理.stream) {
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        ...剩余头,
      },
    });
  }

  const data = await upstream.text();
  return new NextResponse(data, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...剩余头 },
  });
}
