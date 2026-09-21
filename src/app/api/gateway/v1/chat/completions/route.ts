import { NextResponse } from "next/server";
import { 网关认证, 网关错误 } from "@/lib/tenant/gateway-auth";
import { 收拾请求体 } from "@/lib/gateway";
import { 按问题扣一次, 规整请求id, 退这一次 } from "@/lib/tenant/credits";
import { consumeAiQuota } from "@/lib/ai-quota";
import { 读用量, 记一次 } from "@/lib/tenant/ai-cost";

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
 *   3. 额度 —— **在转发之前扣**，但扣的单位是**一个问题**，不是一次请求：
 *      客户端给每个问题一个 `X-Question-Id`，同一个 id 的后续几步不再扣
 *      （agent 一个问题要跑好几步，见 lib/tenant/credits.ts 的 按问题扣一次）。
 *      仍然是「在转发之前」：限的是发起而不是成功，否则反复重试等于无限免费。
 *      **但上游自己出的错要退**（超时 / 5xx / 429 / 连不上）——那不是用户的问题，
 *      他什么都没拿到。用户自己中断的不退：那一次上游已经在跑了。
 */
/**
 * 这次调用是哪个功能发起的。**只进成本账**，不影响任何判断，所以认不出就当没有。
 * 白名单而不是原样收下：它会进库、会出现在运营台的分组里，不该让客户端往里写任意字符串。
 * 和 lib/llm.ts 里发出去的那几个名字必须对得上——加一个就两处都要加。
 */
const 功能白名单 = new Set(["ask", "brief", "draft", "parse", "paste", "import", "other"]);
function 认功能(v: string | null): string | null {
  const s = (v ?? "").trim().toLowerCase();
  return 功能白名单.has(s) ? s : null;
}

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
  /*
    这个问题的编号，和这次调用是哪个功能发起的。两样都来自客户端的头，都可以没有：
      没有 requestId → 退回「一次调用扣一次」的老口径（老版本桌面端、第三方客户端）
      没有 feature   → 成本账里这一行归不了类，仅此而已
    feature 只进成本账、不影响任何判断，所以白名单卡一下就够，不值得为它拒绝请求。
  */
  const 问题id = 规整请求id(req.headers.get("x-question-id"));
  const 功能 = 认功能(req.headers.get("x-feature"));
  const 扣 = await 按问题扣一次(owner, 问题id);
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
    // 上游没给出任何东西：这一次不该由用户买单
    await 退这一次(owner, 问题id, 扣.扣了);
    const 超时 = e instanceof Error && e.name === "TimeoutError";
    return 网关错误(504, 超时 ? "上游模型接口超时" : "连不上上游模型接口", 剩余头);
  }

  if (!upstream.ok) {
    /**
     * 上游的报错原样带回去（截断），但**不带上游的响应头**——那里可能有它的限流、
     * 计费一类的信息，那是我们和上游之间的事，不该让客户端看见。
     *
     * 正文里也要把 GATEWAY_API_KEY 抹掉：有些中转站鉴权失败时会把收到的 Key
     * 回显在错误体里，而这里的客户端是**用户的桌面端**——那把 Key 是我们的，
     * 一旦回显出去，拿到的人就能直接花我们的钱。
     */
    /*
      **只退我们这边的错。** 5xx 是上游炸了、429 是上游限我们、408 是它自己超时——
      这三种用户什么都没拿到，不该他买单。

      其余 4xx 不退（400 请求体不对、413 太大……）：那是这次请求本身有毛病，
      而「构造一个必定失败的请求」如果能退，就等于一条无限免费的路。
      这正是 2026-09-20 之前那条「失败也算一次」的规矩要挡的东西，规矩没变，
      只是把「我们的锅」从里面摘了出来。
    */
    if (upstream.status >= 500 || upstream.status === 429 || upstream.status === 408) {
      await 退这一次(owner, 问题id, 扣.扣了);
    }
    const 上游Key = process.env.GATEWAY_API_KEY ?? "";
    let text = (await upstream.text()).slice(0, 500);
    if (上游Key.length >= 8) text = text.split(上游Key).join("****");
    return 网关错误(upstream.status, `上游模型接口返回 ${upstream.status}：${text}`, 剩余头);
  }

  /*
    流式：直接把上游的流接出去，不缓冲——缓冲了就没有"逐字出现"这回事了。
    **代价是这一条记不到 token**：usage 在事件流的最后一块里，而我们没有拆流。
    要记的话得给上游加 `stream_options: {include_usage: true}` 再把流接一道，
    中转站支不支持要先试。眼下只有「最终回答」那一次是流式的，agent 循环里
    每一步（chatTools / chatMessagesJSON）都是非流式的，下面那条记得到。
  */
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

  /*
    成本账。桌面端的请求只有经过这里才看得见 token——它那边的 llm.ts 跑在
    用户自己机器上，连不到控制面库。**记不上不许影响这次回答**：
    try/catch 全包在 记一次 里，这里连 await 都不 await。
  */
  try {
    const u = 读用量(JSON.parse(data));
    if (u) await 记一次({ kind: "account", id: accountId }, { model: String(整理.body.model ?? ""), usage: u, feature: 功能 });
  } catch {
    // 上游回的不是 JSON —— 那是上面 upstream.ok 该管的事，这儿不掺和
  }

  return new NextResponse(data, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...剩余头 },
  });
}
