import { CompletionStream } from "./llm-stream";
/**
 * LLM 调用层 —— 任何 OpenAI 兼容接口（DeepSeek 官方、OpenAI、中转站、本地 Ollama…）。
 * 配置（Key、接口地址、模型名从哪来）在 llm-config.ts，这里原样转出，调用方只认这一个入口。
 *
 * 几条用真实回归换来的规矩：
 *   1. 显式传 max_tokens 与超时——不传时实际上限取决于网关自己的默认值，
 *      不透明也不一致，"输出被截断"和"模型没遵循格式"两种失败会混在一起
 *   2. response_format=json_object 失败时降级为普通调用（部分网关不支持该参数）
 *   3. 返回内容先剥代码围栏再解析；仍不是合法 JSON 时带着原始输出重试一次
 *
 * 只在 Server Action / 服务端调用，key 不会下发到浏览器。
 */
import { getBusiness } from "./business";
import { 记托管版一次 } from "./tenant/ai-cost";
import { 有DSML, 解析DSML } from "./llm-dsml";
import { 抹掉密钥 } from "./secret";
import type { AI功能 } from "./ai-features";
import { getLlmConfig, type LlmConfig } from "./llm-config";
import { 本地模式 } from "./desktop/cloud";

export * from "./llm-config";

export function stripCodeFence(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    const lines = t.split("\n").slice(1);
    if (lines.length && lines[lines.length - 1].trim().startsWith("```")) lines.pop();
    t = lines.join("\n");
  }
  return t.trim();
}

/** 系统提示词：业务简介来自设置页，改一段话所有 AI 功能一起换语境 */
export function buildSystemPrompt(brief: string): string {
  return (
    "你是 CRM 系统的录入与分析助手，服务一个销售团队。他们的业务：" + brief + "\n" +
    "严格依据用户提供的信息作答，禁止编造事实。" +
    "必须只输出用户要求的 JSON，不要输出任何 JSON 之外的文字、解释或 Markdown 代码块标记。"
  );
}

type ChatOpts = {
  /**
   * 推理模型（如 deepseek-v4-flash）的 max_tokens 会先被思维链（reasoning_content）
   * 消耗，给小了正文直接为空（finish_reason=length）——真实踩坑：给 200 时
   * 371 字符的思维链就把预算吃光了。默认给足，别按"预期输出长度"来省。
   */
  maxTokens?: number;
  temperature?: number;
  /** 默认 60 秒。CRM 的 prompt 都不大，卡住时要快速失败而不是让销售干等 */
  timeoutMs?: number;
  /** 上游取消（用户按 Esc）时中断请求 */
  signal?: AbortSignal;
  /** 这次调用改用哪个模型。必须是 resolveModel 校验过的名字 */
  model?: string;
  /**
   * 这次调用是哪个功能发起的（ask / brief / parse…），只进成本账，不影响请求。
   * 不填也能用——只是回头算「哪块烧得最凶」时这一行归不了类。
   */
  feature?: AI功能;
  /**
   * **这一次属于哪个问题。** 同一个问题的每一步（agent 决策、工具、最终回答）都带同一个，
   * 网关据此只扣一次——价格页那句「一次提问算一次」的实现就在这一对头上
   * （见 lib/tenant/credits.ts 的 按问题扣一次）。
   *
   * 不填也能用：网关认不出就退回「一次调用扣一次」的老口径。自己填 Key 的人
   * （BYOK、自部署）根本不走我们的网关，这个头对上游是个无害的多余字段。
   */
  requestId?: string;
  /**
   * false = 关掉推理模型的思维链（DeepSeek 的 thinking 参数）。
   * agent 的每步决策只是选工具、填参数，让它"想"一分钟是浪费：真实测过同一段
   * 上下文开着思维链 24~73 秒、关掉 3 秒。最终回答仍开着，质量要紧。
   * 网关不认这个参数时会 4xx，调用方降级重试时去掉它。
   */
  thinking?: false;
};

const DEFAULT_MAX_TOKENS = 4000;

/**
 * 下面两张表记的都是「试探出来的模型行为」。
 *
 * **键是「接口地址 + 模型名」，不是光模型名。**
 * 这两张表是进程级的，而托管版一个进程伺候所有工作区。只按模型名记的话，
 * A 工作区对着自己的中转站试出来的结论，会套到 B 工作区头上——而同一个
 * 「deepseek-chat」在两家中转站上的行为完全可能不一样（一家能关思维链、
 * 一家不能）。那样 B 要么白发一个会被 400 的参数，要么被多扣 2500 的预算。
 *
 * 反过来，**同一个接口地址 + 同一个模型就该共享**：那本来就是同一个上游，
 * 试探一次的结论对谁都成立，这正是这层缓存存在的理由。所以不按工作区分，
 * 按上游分——这才是这件事真正的归属。
 */
function 上游键(cfg: LlmConfig, model: string): string {
  return `${cfg.baseUrl}|${model}`;
}

/**
 * 记住哪些模型不认 thinking 参数。
 *
 * 中转站上的推理模型分两类：一类可以 {"type":"disabled"} 关掉思维链，另一类
 * 「始终思考」，带上这个参数直接 400。光靠调用方 catch 后重试是不够的——
 *   1. agent 循环最多 6 步，每步都要先失败一次再重试，一个问题白跑 6 个往返
 *   2. 更糟的是 chatMessagesJSON 里「模型没输出合法 JSON」那条恢复路径，
 *      它用的还是原始 opts，等于把刚刚失败的参数又加回去，于是 400 冒到界面上
 * 所以把结论记在这里：某个上游的某个模型拒绝过一次，之后就不再给它带这个参数。
 * 进程内缓存，重启后重新试探一次，代价是一个请求。
 */
const 不认thinking = new Set<string>();

/**
 * 见过思维链的模型。
 *
 * max_tokens 是「思考 + 正文」共用的预算，不是正文的预算。实测一个只要求输出
 * {"ok":true} 的请求就烧掉 92 个 reasoning token——给 100 的额度时
 * finish_reason 直接是 length，正文被截断，JSON.parse 失败，
 * 界面上显示「AI 返回内容不是合法 JSON：」后面空空如也，查不出原因。
 *
 * 所以对这类模型额外加一笔思考预算。调用方给的 maxTokens 是它对**正文**的预期，
 * 这个语义不该因为换了个会思考的模型就变味。
 */
const 思考模型 = new Set<string>();
const 思考预算 = 2500;

/** 测试用：把试探出来的结论清掉，让下一次重新试 */
export function 重置模型探测() {
  不认thinking.clear();
  思考模型.clear();
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * 原生 function calling 用的消息。比 ChatMessage 多两种形状：
 *   assistant 带 tool_calls —— 模型说「我要调这几个工具」
 *   role: "tool"           —— 我们把那次调用的结果交回去（靠 tool_call_id 对上）
 */
export type ToolMessage =
  | ChatMessage
  | { role: "assistant"; content: string | null; tool_calls: 工具调用[] }
  | { role: "tool"; content: string; tool_call_id: string };

export type 工具调用 = { id: string; type: "function"; function: { name: string; arguments: string } };
export type 工具声明 = { type: "function"; function: { name: string; description: string; parameters: unknown } };

/**
 * 第一次等多久就重发（见 chatRaw）。导出给测试改小。
 * 实测（2026-10-02）：「AI 解析」同一份请求跑 6 次，正常 9–14 秒，3 次卡了 140–235 秒；agent 决策正常 2–3 秒。
 * 非流式要等整段写完才回：短的（≤2000，agent 决策）25 秒，中等（≤4000，解析 / 简报）45 秒；流式收到响应头就算回音，20 秒
 */
/*
  短输出 25 → 15 秒（2026-10-06 G.3 实测）：同一份 agent 决策请求直打中转站 5 次，4 次 2–4 秒回、1 次 60 秒没回音——
  卡住的约五分之一，正常的 3 秒左右。等 25 秒才重发，每问第一步常常白等 25 秒
*/
export const 首字等待毫秒 = { 流式: 20_000, 短输出: 15_000, 中输出: 45_000 };

async function chatRaw(cfg: LlmConfig, messages: ToolMessage[], opts: ChatOpts, useJsonFormat: boolean, stream: boolean, tools?: 工具声明[]): Promise<Response> {
  const 模型 = opts.model ?? cfg.model;
  const 键 = 上游键(cfg, 模型);
  const body: Record<string, unknown> = {
    model: 模型,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: (opts.maxTokens ?? DEFAULT_MAX_TOKENS) + (思考模型.has(键) ? 思考预算 : 0),
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  // 带着 tools 时不能再要 json_object：两个一起发，多数网关会二选一地忽略掉其中一个
  if (useJsonFormat && !tools?.length) body.response_format = { type: "json_object" };
  if (opts.thinking === false && !不认thinking.has(键)) body.thinking = { type: "disabled" };
  if (stream) body.stream = true;
  /*
    两个只有我们自己的网关会看的头。对别家上游（DeepSeek 直连、第三方中转）是多余字段，
    HTTP 的规矩是不认识的头忽略掉，所以无条件带上比「判断是不是我们的网关」更稳——
    后者要拿 baseUrl 做字符串匹配，而那个地址是用户在设置里填的。
      X-Question-Id —— 这一次属于哪个问题（不用 X-Request-Id：那个名字网关和 CDN 自己会注入），网关据此一个问题只扣一次
      X-Feature    —— 哪个功能发起的，只进成本账。名字要和网关那份白名单对得上
  */
  const 额外头: Record<string, string> = {};
  if (opts.requestId) 额外头["X-Question-Id"] = opts.requestId;
  if (opts.feature) 额外头["X-Feature"] = opts.feature;
  /*
    等不到就快点重发一次（2026-10-02 实测）：中转站偶尔对同一份请求卡 30–200 秒才回第一个字，
    原样重发通常 3 秒内就回来了。原来干等满 60 / 120 秒，用户对着「在想」等两分钟。
    只对「本该很快回来」的请求这么做：流式（fetch 在收到响应头时就返回）和输出不超过 4000 的非流式；
    要长篇输出的（粘贴整理 8000 token）照旧等满。重发带着同一个问题编号，网关不会多扣次数。
  */
  const 总超时 = opts.timeoutMs ?? 60_000;
  // 按调用方要的输出长度判（body.max_tokens 里可能叠了思考预算）：粘贴大名单那种 8000 的照旧等满
  const 该快 = stream || (opts.maxTokens ?? DEFAULT_MAX_TOKENS) <= 4_000;
  // agent 每一步决策（1500）正常 2–3 秒，25 秒就算卡住；解析 / 简报（默认 4000）正常 9–14 秒，给 45 秒
  const 要多长 = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const 首轮 = 该快 ? Math.min(总超时, stream ? 首字等待毫秒.流式 : 要多长 <= 2_000 ? 首字等待毫秒.短输出 : 首字等待毫秒.中输出) : 总超时;
  const 发 = (等: number) =>
    fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}`, ...额外头 },
      body: JSON.stringify(body),
      signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(等)]) : AbortSignal.timeout(等),
    });
  let res: Response;
  const 起 = Date.now();
  /** 重发给多久：总共还剩多少就给多少，至少 15 秒（原来写成 总超时 − 首轮，502 秒回时长输出的重发只剩 15 秒，第四轮 B1） */
  const 还剩 = () => Math.max(15_000, 总超时 - (Date.now() - 起));
  /*
    5xx 重发只在一次都没重发过时做（第三轮 B5：原来超时重发和 5xx 重发叠起来）。
    超时重发（2026-10-06 G.3）：中转站约五分之一的请求会卡住，只重发一次的话连卡两次（约 4%）就是「超时没回音」，
    还白扣了次数。**短请求**（agent 每一步决策、流式回答，正常几秒回）最多重发两次：第二次照首轮的快等，第三次给剩下的全部时间。
    中等长度的（AI 解析、简报，正常 9–14 秒、首等 45 秒）照旧最多两趟——再多一趟人要等两分钟（J-139）。
    几次都带同一个问题编号，网关只扣一次
  */
  const 最多 = stream || 要多长 <= 2_000 ? 3 : 2;
  let 重发过 = false;
  try {
    for (let 第 = 1; ; 第++) {
      try {
        res = await 发(第 === 最多 ? 还剩() : 首轮);
        break;
      } catch (e) {
        const 人停的 = opts.signal?.aborted;
        if (!(e instanceof Error && e.name === "TimeoutError") || 人停的 || 首轮 >= 总超时 || 第 === 最多 || Date.now() - 起 >= 总超时) throw e;
        console.warn(`[llm] ${Math.round(首轮 / 1000)} 秒没等到回音，重发一次（第 ${第 + 1} 次）`);
        重发过 = true;
      }
    }
  } catch (e) {
    // 超时、人点了停：原样抛，调用方按 name 认（TimeoutError / AbortError）
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw e;
    // 断网时 fetch 抛的是一句英文「fetch failed」，原来直接摆到界面上（2026-10-02 排查 AI B1）
    throw new Error("连不上 AI 服务，检查一下网络再试");
  }
  /*
    502 / 503 / 504：中转站或网关临时出错，原样重发一次（第二轮 AI）。原来 agent 碰到它会退回 JSON 协议「碰巧」救回来，
    现在 agent 不再为 5xx 换协议（换了只是多等），这一跳改在这里做。网关对失败的那次已经退了，重发不会多扣
  */
  if ([502, 503, 504].includes(res.status) && !opts.signal?.aborted && !重发过) {
    console.warn(`[llm] 上游 ${res.status}，重发一次`);
    await res.body?.cancel().catch(() => {});
    try {
      res = await 发(还剩());
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw e;
      throw new Error("连不上 AI 服务，检查一下网络再试");
    }
  }
  if (!res.ok) {
    const errText = 抹掉密钥((await res.text()).slice(0, 300), cfg.apiKey);
    // 只有明确指向thinking本身的不支持才缓存，普通参数或tools组合错误不能推断模型能力。
    const thinking不支持 = /thinking|思考|推理/i.test(errText) &&
      /not.support|unsupported|unknown|unrecognized|not.allowed|不支持|不认|不允许/i.test(errText) &&
      !/\btools?\b|function.call/i.test(errText);
    if (body.thinking && (res.status === 400 || res.status === 422) && thinking不支持) {
      不认thinking.add(键);
      console.warn(`[llm] 模型 ${模型} 在 ${cfg.baseUrl} 上不支持关闭思考，后续不再发送该参数`);
    }
    /*
      走我们网关的（桌面端）说人话；自己填 Key 的（自部署、网页设置里测连接）照旧给原文——
      那些人要靠这串原文去查自己的接口哪里不对（Key 已抹掉）
    */
    // 认的是「这次打的是不是我们的网关」，不是「是不是桌面端」：桌面端也能自己填 Key（复查 R：原来 Key 填错了被叫去退出重登我们的账号）
    const 网关的 = /\/api\/gateway\/v1\/?$/.test(cfg.baseUrl) || /"type"\s*:\s*"gateway_error"/.test(errText);
    throw Object.assign(new Error(网关的 ? AI报错人话(res.status, errText) : `接口返回 ${res.status}：${errText}`), { status: res.status });
  }
  return res;
}

async function chatOnce(cfg: LlmConfig, system: string, prompt: string, opts: ChatOpts, useJsonFormat: boolean): Promise<string> {
  return chatMessagesOnce(cfg, [{ role: "system", content: system }, { role: "user", content: prompt }], opts, useJsonFormat);
}

/**
 * 读回模型接口的 JSON。读不出来的（酒店 / 公司网的登录页、反代回的 HTML）说人话，不摆英文的 SyntaxError（第二轮 AI）
 */
async function 读回JSON<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    console.warn(`[llm] 回来的不是 JSON：${text.slice(0, 200)}`);
    throw new Error("AI 服务回来的东西看不懂（可能网络被拦了，比如要先登录的 Wi-Fi），换个网络或稍后再试");
  }
}

async function chatMessagesOnce(cfg: LlmConfig, messages: ToolMessage[], opts: ChatOpts, useJsonFormat: boolean): Promise<string> {
  const res = await chatRaw(cfg, messages, opts, useJsonFormat, false);
  const data = await 读回JSON<{
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
  }>(res);
  const model = opts.model ?? cfg.model;
  const 键 = 上游键(cfg, model);

  // 这个上游的这个模型会思考：记下来，之后给它的预算都加上思考那一笔
  if ((data.usage?.completion_tokens_details?.reasoning_tokens ?? 0) > 0 && !思考模型.has(键)) {
    思考模型.add(键);
    console.warn(`[llm] 模型 ${model} 在 ${cfg.baseUrl} 上会输出思维链，后续 max_tokens 额外加 ${思考预算}`);
  }

  // 成本账。fire-and-forget，不 await、不判断成败——记不上不该影响这次回答
  await 记托管版一次(data, model, opts.feature);

  const choice = data.choices?.[0];
  const content = (choice?.message?.content ?? "").trim();
  // 200 但什么都没回（choices 空）：原来往下走成「不是合法 JSON：」后面空着
  if (!choice) throw new Error("AI 这次什么都没回，再试一次");

  /**
   * 被 max_tokens 截断。必须在这里就炸出来，不能把半截内容交给 JSON.parse：
   * 那样报的是「返回内容不是合法 JSON」，把「额度不够」说成「模型不听话」，
   * 方向完全错，线上排查会绕很久。调用方接住之后重试，那时预算已经加上去了。
   */
  if (choice?.finish_reason === "length") {
    throw new Error(`AI 回答被长度限制截断（模型 ${model}）。请缩短本次内容，或分成几批处理`);
  }
  return content;
}

/**
 * 多轮对话版的 JSON 调用：给 agent 循环用（system + 历史 + 工具结果）。
 * 同样带「不支持 json_object 就降级」和「坏 JSON 重试一次」两道保险。
 */
/** 降级（去掉 response_format / thinking 再来一次）只救得了「请求体不被认」的 4xx；这几种换了也一样 */
function 换协议也没用(e: unknown): boolean {
  const st = (e as { status?: number }).status ?? 0;
  return st >= 500 || st === 429 || st === 401 || st === 402 || st === 403;
}
/** 修 JSON 那一步的降级：再加上超时和人点了停 */
function 不该降级(e: unknown): boolean {
  return 换协议也没用(e) || (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"));
}

export async function chatMessagesJSON(messages: ToolMessage[], opts: ChatOpts = {}): Promise<unknown> {
  const cfg = await getLlmConfig();
  if (!cfg) throw new Error(AI未启用说法());
  let content: string;
  try {
    content = await chatMessagesOnce(cfg, messages, opts, true);
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw e.name === "AbortError" ? e : new Error("AI 响应超时，请稍后重试");
    // 换个请求体也救不回来的（5xx 已在 chatRaw 重发过、限流、令牌 / 权限）：直接抛，别给出错的上游再加一轮（第三轮 B5）
    if (换协议也没用(e)) throw e;
    // 网关不认 response_format / thinking 时是 4xx：两个都去掉再试一次
    console.warn(`[llm] JSON 调用失败，降级重试：${e instanceof Error ? e.message.slice(0, 160) : e}`);
    content = await chatMessagesOnce(cfg, messages, { ...opts, thinking: undefined }, false);
  }
  try {
    return JSON.parse(stripCodeFence(content));
  } catch {
    const retry = await chatMessagesOnce(cfg, [...messages, { role: "assistant", content }, { role: "user", content: "你上一次的输出不是合法 JSON，请只输出严格合法的 JSON。" }], opts, true).catch((e) => {
      // 降级只救「请求体不被认」；超时、人点停、5xx / 429 / 令牌这些换协议也没用，直接抛（第四轮 B2）
      if (不该降级(e)) throw e;
      return chatMessagesOnce(cfg, messages, opts, false);
    });
    try {
      return JSON.parse(stripCodeFence(retry));
    } catch {
      throw new Error(`AI 返回内容不是合法 JSON：${retry.slice(0, 200)}`);
    }
  }
}

/**
 * 一轮**原生 function calling**。
 *
 * 和 chatMessagesJSON 的区别：那边是我们规定一套 JSON 格式、求模型照着填；
 * 这边把工具表按 OpenAI 的 `tools` 字段发过去，模型走的是它自己训练过的那条路。
 * 小模型在这件事上的差距很大——JSON 协议下它要同时记住「格式」和「选哪个工具」，
 * 原生这条只剩后者。
 *
 * 网关或模型不支持时抛错，由调用方退回 JSON 协议那条路（run.ts 里做的）。
 */
export async function chatTools(
  messages: ToolMessage[],
  tools: 工具声明[],
  opts: ChatOpts = {},
): Promise<{ toolCalls: 工具调用[]; text: string }> {
  const cfg = await getLlmConfig();
  if (!cfg) throw new Error(AI未启用说法());
  const res = await chatRaw(cfg, messages, opts, false, false, tools);
  const data = await 读回JSON<{
    choices?: { message?: { content?: string | null; tool_calls?: 工具调用[] }; finish_reason?: string }[];
  }>(res);
  await 记托管版一次(data, opts.model ?? cfg.model, opts.feature);
  const m = data.choices?.[0]?.message;
  const toolCalls = m?.tool_calls ?? [];
  const text = (m?.content ?? "").trim();
  /*
    中转站没把 DeepSeek 的原生标记转成 tool_calls、原样塞在正文里交回来（2026-09-28 桌面端真碰到的）。
    不认回来的话，这一步就被当成「没调工具」：工具没跑、建议卡没出，回答时它还以为出了。见 llm-dsml.ts
  */
  if (!toolCalls.length && 有DSML(text)) {
    const 认 = 解析DSML(text, tools.map((t) => t.function.name));
    if (认.调用.length) {
      console.warn(`[llm] 工具调用被当正文吐回（DSML），已认回：${认.调用.map((c) => c.function.name).join(",")}`);
      return { toolCalls: 认.调用, text: 认.余下 };
    }
  }
  return { toolCalls, text };
}

/**
 * 流式文本：逐 token 回调，给最终回答用——人看到字一个个出来，而不是等十几秒砸出一整块。
 * 网关不支持 stream 时（响应不是事件流）退化为一次性返回。
 */
export async function chatTextStream(messages: ToolMessage[], opts: ChatOpts, onToken: (text: string) => void): Promise<string> {
  const cfg = await getLlmConfig();
  if (!cfg) throw new Error(AI未启用说法());
  const res = await chatRaw(cfg, messages, opts, false, true);
  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.includes("text/event-stream") || !res.body) {
    const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
    const text = (data?.choices?.[0]?.message?.content ?? "").trim();
    if (text) onToken(text);
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const state = new CompletionStream(onToken);
  try {
    while (!state.done) {
      const { value, done } = await reader.read();
      if (done) { state.push(decoder.decode()); state.finish(); break; }
      state.push(decoder.decode(value, { stream: true }));
    }
    if (!state.complete) throw new Error("Incomplete stream");
    return state.text.trim();
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw e;
    throw new Error(state.text ? "回答写到一半断了（网络不稳），上面是已经写出来的部分，可以再问一次" : "回答还没开始就断了（网络不稳），再问一次试试");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }

}

/**
 * 测试连接：发一次最小请求，回显耗时与模型原话。填错地址、key、模型名当场就知道。
 */
export async function testLlm(cfg: LlmConfig): Promise<{ ok: true; ms: number; reply: string } | { ok: false; error: string }> {
  const t0 = Date.now();
  try {
    const reply = await chatOnce(
      cfg,
      "你是连通性测试的应答方。",
      "请只回复两个字：连接正常",
      { maxTokens: 200, timeoutMs: 20_000 },
      false,
    );
    return { ok: true, ms: Date.now() - t0, reply: reply.slice(0, 100) || "（空回复）" };
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") return { ok: false, error: "20 秒内没有响应：检查接口地址是否可达" };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 调用模型并要求返回 JSON，返回已 parse 的对象。
 * 抛出的 Error 带中文信息，可直接展示给使用者。
 */
export async function chatJSON(prompt: string, opts: ChatOpts = {}): Promise<unknown> {
  const cfg = await getLlmConfig();
  if (!cfg) {
    throw new Error(AI未启用说法());
  }
  const system = buildSystemPrompt((await getBusiness()).brief);
  /*
    这一次 chatJSON 里的几道重试（降级、修 JSON）共用一个问题编号：桌面端走我们的网关，
    网关按编号一个问题只扣一次。原来不带编号，按钮标「1 次」，模型回了坏 JSON 或中转站不认 response_format 时
    实际扣 2–4 次，而且不退（2026-10-02 排查 AI A2）。调用方自己给了编号（同一个问题的多步）就用它的。
  */
  opts = { ...opts, requestId: opts.requestId ?? globalThis.crypto.randomUUID() };

  let content: string;
  try {
    content = await chatOnce(cfg, system, prompt, opts, true);
  } catch (e) {
    // 网关不支持 response_format 时表现为 4xx，降级为普通调用再试一次；
    // 网络/超时类错误也顺带走这条兜底（多花一次调用，换少一类需要人排查的失败）
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new Error("AI 响应超时，请稍后重试");
    }
    // 5xx 在 chatRaw 里已经原样重发过一次了：再降级重试只是给正在出错的上游多加一倍请求
    if (换协议也没用(e)) throw e;
    content = await chatOnce(cfg, system, prompt, opts, false);
  }

  const cleaned = stripCodeFence(content);
  try {
    return JSON.parse(cleaned);
  } catch {
    // 带着上次的坏输出重试一次，让模型自己修
    const repairPrompt =
      `${prompt}\n\n【注意】你上一次的输出不是合法 JSON：\n${content.slice(0, 500)}\n` +
      "请只输出严格合法的 JSON，不要输出任何其他文字。";
    const retried = stripCodeFence(
      await chatOnce(cfg, system, repairPrompt, opts, true).catch((e) => {
        if (不该降级(e)) throw e;
        return chatOnce(cfg, system, repairPrompt, opts, false);
      }),
    );
    try {
      return JSON.parse(retried);
    } catch {
      throw new Error(`AI 返回内容不是合法 JSON：${retried.slice(0, 200)}`);
    }
  }
}

/**
 * 模型接口报错时给人看的那一句（2026-10-02 排查 AI B1）。
 *
 * 原来是「接口返回 402：{"error":{"message":"免费的 AI 次数已经用完…","type":"gateway_error"}}」整串摆到界面上，
 * 桌面端用户看不懂，也看不出该做什么。网关自己的报错正文是中文的那句 message，取出来；其余按状态码说人话。
 * 原文照旧进服务端日志（抹掉 Key 之后）。
 */
export function AI报错人话(status: number, 正文: string): string {
  let 说: string | undefined;
  try {
    const j = JSON.parse(正文) as { error?: { message?: string } | string; message?: string };
    说 = typeof j.error === "string" ? j.error : j.error?.message ?? j.message;
  } catch {
    /* 不是 JSON */
  }
  const 中文 = 说 && /[\u4e00-\u9fa5]/.test(说) ? 说 : undefined;
  if (status === 402) return 中文 ?? "AI 次数用完了";
  if (status === 401 || status === 403) return 中文 ?? "AI 登录凭据失效了，请在设置里退出登录再登录一次";
  if (status === 429) return 中文 ?? "问得太快了，稍等一会儿再试";
  if (status >= 500) {
    console.warn(`[llm] 上游 ${status}：${正文.slice(0, 300)}`);
    return "AI 服务暂时不可用，稍后再试";
  }
  if (中文) return 中文;
  console.warn(`[llm] 接口返回 ${status}：${正文.slice(0, 300)}`);
  return `AI 接口没接受这次请求（${status}），稍后再试；一直这样请从「反馈」告诉我们`;
}

/** 没有可用的 AI 配置时那句话。桌面端没有「管理员」也没有「设置管理」：那里是没登录、或登录信息坏了（第二轮 AI） */
function AI未启用说法(): string {
  return 本地模式()
    ? "AI 要先登录云端账号：在设置里退出登录，再登录一次"
    : "AI 功能未启用：请管理员到「设置 → AI 接入」填写接口地址与 API Key";
}
