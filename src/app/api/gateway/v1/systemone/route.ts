import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 网关错误 } from "@/lib/tenant/gateway-auth";
import { 认领, 取Bearer } from "@/lib/tenant/device-token";
import { consumeAiQuota } from "@/lib/ai-quota";
import { JEV上游, JEV模型 } from "@/lib/jev/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 判断类模型的网关。桌面端专用。
 *
 * ## 为什么桌面端非要绕这一圈
 *
 * 用户手上不会有 TypeSafe 的 key，而我们的 key 不能打进安装包——打进去就能被扒出来，
 * 谁拿到谁花我们的钱。所以和 DeepSeek 那条路一样：桌面端拿**设备令牌**来，我们替他转发。
 *
 * ## 和隔壁 /chat/completions 的三处不同
 *
 *   1. **不扣免费次数。** 那本账是给生成类记的——一次几分钱、用户主动点。
 *      判断类一次两万分之一美分、而且是自动跑的，记进去等于把额度花在用户看不见的地方。
 *      见隐私政策第三节：这两类是分开讲的。
 *   2. **不看 GATEWAY_API_KEY，看 JEV_API_KEY。** 两个上游、两把钥匙，
 *      只配了一边时另一边就该是 404，而不是拿着空 key 去撞上游。
 *   3. **model 由我们定，不听客户端的。** 客户端能指定模型就意味着它能指定我们的账单。
 *
 * ## 正文封顶
 *
 * 这扇门认的是设备令牌，而令牌躺在用户自己的机器上——能不能拿到它，不在我们控制之内。
 * 限流挡的是「循环脚本」，封顶挡的是「一次塞一本书」：那两件事是分开的，都得有。
 * 真实的导入猜列一次 8k tokens 上下、三十来 KB，256 KB 是宽到不会误伤的地板。
 */
const 正文上限 = 256 * 1024;

export async function POST(req: Request) {
  // 网关是托管侧的东西。自部署版、桌面端自己跑的那个服务里，这条路就该不存在
  if (!multiTenant() || !process.env.JEV_API_KEY?.trim()) {
    return NextResponse.json({ error: { message: "Not Found" } }, { status: 404 });
  }

  const who = await 认领(取Bearer(req));
  if (!who) return 网关错误(401, "设备令牌无效或已被吊销，请在桌面端重新登录");

  // 和模型网关分开计数：判断类一次几毫秒，和「五分钟三十次对话」不是一个节奏
  const 等 = consumeAiQuota(`jev:${who.accountId}`);
  if (等 !== null) return 网关错误(429, `请求太频繁，请 ${等} 秒后再试`);

  const raw = await req.text();
  if (raw.length > 正文上限) {
    return 网关错误(413, `请求体太大（${Math.round(raw.length / 1024)} KB），上限 ${正文上限 / 1024} KB`);
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return 网关错误(400, "请求体不是合法 JSON");
  }
  if (!body.questions || typeof body.questions !== "object") {
    return 网关错误(400, "缺 questions");
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${JEV上游()}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.JEV_API_KEY!.trim()}` },
      // model 覆盖掉客户端传来的：客户端能选模型就等于能选我们的账单
      body: JSON.stringify({ ...body, model: JEV模型 }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const 超时 = e instanceof Error && e.name === "TimeoutError";
    return 网关错误(504, 超时 ? "判断模型超时" : "连不上判断模型");
  }

  if (!upstream.ok) {
    /**
     * 原样带回状态码和（截断的）正文，但**把我们的 key 抹掉**——理由同 /chat/completions：
     * 有些上游鉴权失败时会把收到的 Key 回显在错误体里，而这里的客户端是用户的桌面端。
     */
    const 我们的key = process.env.JEV_API_KEY!.trim();
    let text = (await upstream.text()).slice(0, 500);
    if (我们的key.length >= 8) text = text.split(我们的key).join("****");
    return 网关错误(upstream.status, `判断模型返回 ${upstream.status}：${text}`);
  }

  return new NextResponse(await upstream.text(), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
