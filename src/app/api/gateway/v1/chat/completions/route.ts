import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { 网关认证, 网关错误 } from "@/lib/tenant/gateway-auth";
import { 收拾请求体 } from "@/lib/gateway";
import { 按问题扣一次, 规整请求id, 退这一次, 每问最多步, 注册赠送发过吗 } from "@/lib/tenant/credits";
import { consumeAiQuota } from "@/lib/ai-quota";
import { 读用量, 记一次 } from "@/lib/tenant/ai-cost";
import { 抹掉密钥 } from "@/lib/secret";
import { AI功能 } from "@/lib/ai-features";

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
 *      他什么都没拿到。桌面端中途走了（超时、点了停）的：这个问题最新的那一份没人收到就退，见 问过的 那段。
 */
/**
 * 这次调用是哪个功能发起的。**只进成本账**，不影响任何判断，所以认不出就当没有。
 * 白名单而不是原样收下：它会进库、会出现在运营台的分组里，不该让客户端往里写任意字符串。
 * 名单和发请求那边共用一份（lib/ai-features.ts）。
 */
const 功能白名单 = new Set<string>(AI功能);
function 认功能(v: string | null): string | null {
  const s = (v ?? "").trim().toLowerCase();
  return 功能白名单.has(s) ? s : null;
}

/**
 * 这一阵子见过的问题编号（账号:编号 → 第一次见的时刻、发过几次）。频率闸据此只给每个问题算一次。
 * 放内存：托管版单进程，重启丢了无非是下一步多算一次频率，不影响扣费（扣费在库里按编号去重）
 *
 * **免频率闸也有个数**（第三轮 B6）：同一个编号前 每问最多步 次请求不过频率闸，再往后每一次都照常过。
 * 否则客户端拿同一个编号死循环，频率闸一次都不拦，上游一直 5xx 时还全退。
 * 不直接拒：退回 JSON 协议时一个正常的问题就要十几次，超了照 credits.ts 的规矩是多扣、不是关门。
 */
/**
 * 「最后」：这个编号最近发出的那一份请求的序号。**退不退次数只听最新那一份的**（第四轮）：
 *   - 首轮卡住、重发答出来了，卡住那份后来 504 / 回来时桌面端已走——它不是最新的，不退（否则答到了却 0 次）
 *   - 原请求和重发都慢、桌面端两份都放弃了——重发是最新的，它回来时桌面端已走，退（什么都没拿到）
 *   - 故意「发 → 断 → 同编号再发」：前一份不是最新的，不退；它要是在重发之前就回来退掉了，重发会重新扣
 *   - 0.46.14 首轮超时退回 JSON 协议、那份也超时——JSON 那份是最新的，退
 */
const 问过的 = new Map<string, { t: number; n: number; 最后: number }>();
const 问过留多久 = 15 * 60_000;
let 请求序 = 0;
function 问过(k: string): { t: number; n: number; 最后: number } | null {
  const r = 问过的.get(k);
  return r && Date.now() - r.t < 问过留多久 ? r : null;
}
function 记下问过(k: string) {
  const now = Date.now();
  if (问过的.size > 5000) for (const [key, r] of 问过的) if (now - r.t > 问过留多久) 问过的.delete(key);
  问过的.set(k, { t: now, n: 1, 最后: 0 });
}

/** 没带编号的请求按前两条消息合一个编号。连消息都没有的（不是聊天请求）就算了，照老口径一次一扣 */
function 合成编号(accountId: string, raw: unknown): string | null {
  const m = (raw as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(m) || m.length === 0) return null;
  // 带一个 15 分钟的时间段：扣费按编号记在库里、不看时间，不带的话同一句话隔天再问也不扣（第五轮 B2）。
  // 正好跨过段边界的那个问题会多扣一次，宁可这样也不要永远不扣
  const 段 = Math.floor(Date.now() / (15 * 60_000));
  return "h-" + createHash("sha256").update(`${accountId}\n${段}\n${JSON.stringify(m.slice(0, 2))}`).digest("hex").slice(0, 40);
}

/**
 * 上游给没有参数的工具回 `arguments: "null"`（或空串）时规整成 "{}"（第四轮兼容 S1）：
 * 0.46.14 及更早的 agent 拿它 Object.keys 会崩成一句英文。网关这儿改一下，所有旧客户端都护住
 */
function 规整工具参数(data: string): string {
  try {
    const j = JSON.parse(data) as { choices?: { message?: { tool_calls?: { function?: { arguments?: unknown } }[] } }[] };
    let 改了 = false;
    for (const c of j.choices ?? []) {
      for (const t of c.message?.tool_calls ?? []) {
        const a = t.function?.arguments;
        if (t.function && (a == null || a === "" || a === "null" || typeof a !== "string")) {
          t.function.arguments = typeof a === "object" && a !== null ? JSON.stringify(a) : "{}";
          改了 = true;
        }
      }
    }
    return 改了 ? JSON.stringify(j) : data;
  } catch {
    return data;
  }
}

export async function POST(req: Request) {
  const auth = await 网关认证(req);
  if (!auth.ok) return auth.res;
  const { cfg, accountId } = auth;

  /*
    频率闸按**问题**算，不按请求算（第二轮 AI A2）：一个问题要 3–11 次请求（agent 每一步一次），
    按请求算的话连问七八个就在半路被 429 拦下，而第一步那次已经扣了。同一个问题编号的后续几步不再计数；
    同一编号前 每问最多步 次不计数、再往后照常计（见 问过的 那段）。没带编号的（老客户端）照旧按请求算
  */
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return 网关错误(400, "请求体不是合法 JSON");
  }
  /*
    没带问题编号的老桌面端（0.46.2 及以前）：拿「账号 + 前两条消息」合一个编号（第四轮兼容 B1）。
    网关转了工具表以后，它们一个问题的请求数变多，按请求扣会从 3 次涨到 4–8 次、也更早被 429。
    一个问题的几步前两条（系统提示 + 用户那句话）是一样的；15 分钟内同一句话再问一遍算同一个问题，少扣不多扣
  */
  const 早问题id = 规整请求id(req.headers.get("x-question-id")) ?? 合成编号(accountId, raw);
  const 见过 = 早问题id ? 问过(`${accountId}:${早问题id}`) : null;
  if (!见过 || ++见过.n > 每问最多步) {
    const 等 = consumeAiQuota(`gw:${accountId}`);
    if (等 !== null) return 网关错误(429, `请求太频繁，请 ${等} 秒后再试`);
    if (早问题id && !见过) 记下问过(`${accountId}:${早问题id}`);
  }
  const 键 = 早问题id ? `${accountId}:${早问题id}` : null;
  const 这一份 = ++请求序;
  if (键) {
    const r = 问过的.get(键);
    if (r) r.最后 = 这一份;
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
  const 问题id = 早问题id;
  const 功能 = 认功能(req.headers.get("x-feature"));
  const 扣 = await 按问题扣一次(owner, 问题id);
  if (!扣.ok) {
    // 10-03 起没有每日赠送了：用完就是用完，不说「明天再送」。没领到开户赠送的账号要说清楚为什么一次都没有
    if (!(await 注册赠送发过吗(owner))) {
      return 网关错误(
        402,
        "免费 AI 次数一台电脑只送一份，这台电脑上已经有别的账号领过了" +
          (扣.上限 > 0 ? `（这个账号之前领到的 ${扣.上限} 次已经用完）` : "") +
          "。可以在设置里填自己的模型 API Key，不走我们的额度、也不限次数。",
      );
    }
    return 网关错误(
      402,
      `免费的 AI 次数已经用完（共 ${扣.上限} 次）。` +
        "可以在设置里填自己的模型 API Key，不走我们的额度、也不限次数。",
    );
  }

  const 剩余头 = { "X-Credits-Remaining": String(扣.还剩) };
  /** 这一份失败 / 没人收到时退。同一编号后面又发了一份的，交给那一份决定（见 问过的 那段） */
  const 退 = async () => {
    if (键 && 问过的.get(键)?.最后 !== 这一份) return;
    await 退这一次(owner, 问题id, 扣.扣了 || Boolean(问题id));
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(整理.body),
      /*
        桌面端断开就把上游也掐掉（2026-10-06 G.3）：桌面端 15 秒等不到就重发，原来这一份还挂在中转站上直到 120 秒，
        一个问题最多同时挂三份。掐掉走下面 catch 那支：是最新一份才退次数，和原来「没人收到就退」一个口径
      */
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(120_000)]),
    });
  } catch (e) {
    // 上游没给出任何东西：这一次不该由用户买单。不是扣的那一步也退——这个问题整个答不出来了（第二轮 AI A4）
    await 退();
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
    /*
      401 / 402 / 403 / 404 也是我们的锅（第二轮 AI A1）：请求体已经被 收拾请求体 收拾过，
      上游说 Key 不对、余额不足、没权限、模型不存在，都是我们和中转站之间的事——原来照扣用户，
      每点一次扣一次，界面上还是上游的英文原文。这几种退掉，并说一句人话；原文只进日志。
      不是扣的那一步（同一问题的第 2 步以后）失败了也退：这个问题整个答不出来了（第二轮 AI A4）
    */
    const 我们的锅 = [401, 402, 403, 404].includes(upstream.status);
    if (upstream.status >= 500 || upstream.status === 429 || upstream.status === 408 || 我们的锅) {
      await 退();
    }
    const text = 抹掉密钥((await upstream.text()).slice(0, 500), process.env.GATEWAY_API_KEY);
    // 上游在限我们（429）：退了次数，话也别带上游的英文原文（第二轮 AI）
    if (upstream.status === 429) {
      console.warn(`[gateway] 上游 429：${text}`);
      return 网关错误(429, "AI 那边这会儿太忙了，这次没扣次数，过一会儿再试", 剩余头);
    }
    if (我们的锅) {
      console.error(`[gateway] 上游 ${upstream.status}（我们这边的配置 / 余额问题）：${text}`);
      return 网关错误(503, "AI 服务这边出了点问题（不是你的问题），这次没扣次数，稍后再试", 剩余头);
    }
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
    // 和下面非流式那支一样：上游回响应头时桌面端已经走了（首字等不到、重发也超时），这份没人收到，是最新的就退（第五轮 A1）
    if (req.signal.aborted && 键) {
      await upstream.body?.cancel().catch(() => {});
      await 退();
      return 网关错误(499, "客户端已经断开", 剩余头);
    }
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

  const data = 规整工具参数(await upstream.text());

  /*
    上游 200 但正文不是 JSON（中转站出错时偶尔回一段 HTML）：用户什么都没拿到，退掉，说人话（第二轮 AI）
  */
  let 解得出 = true;
  try {
    JSON.parse(data);
  } catch {
    解得出 = false;
  }
  if (!解得出) {
    await 退();
    console.warn(`[gateway] 上游 200 但不是 JSON：${data.slice(0, 200)}`);
    return 网关错误(502, "AI 服务这次回来的东西不完整，没扣次数，再试一次", 剩余头);
  }
  /*
    桌面端已经走了（首轮超时、整体超时、人点了停）：这份答案没人收到。是这个编号最新的一份就退，
    不是最新的（后面还有重发）就不管——见 问过的 那段（第三轮 A1 / 第四轮 A1、兼容 A0）。
    老客户端（0.46.2 及以前）不带编号，用的是 合成编号，同样按这条退
  */
  if (req.signal.aborted && 键) await 退();

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
