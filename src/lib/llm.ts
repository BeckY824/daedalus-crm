/**
 * LLM 调用层 —— 任何 OpenAI 兼容接口（DeepSeek 官方、OpenAI、中转站、本地 Ollama…）。
 *
 * 配置两级读取：**设置页填的 > 环境变量**。
 *   界面：设置管理 → AI 接入（接口地址 / API Key / 模型名），存在 Setting 表，Key 加密
 *   环境：LLM_API_KEY / LLM_BASE_URL / LLM_MODEL，作为首次初始化与无界面场景的兜底
 * 两处都没 key → AI 能力整体隐藏，CRM 其余功能不受影响。
 *
 * 几条用真实回归换来的规矩：
 *   1. 显式传 max_tokens 与超时——不传时实际上限取决于网关自己的默认值，
 *      不透明也不一致，"输出被截断"和"模型没遵循格式"两种失败会混在一起
 *   2. response_format=json_object 失败时降级为普通调用（部分网关不支持该参数）
 *   3. 返回内容先剥代码围栏再解析；仍不是合法 JSON 时带着原始输出重试一次
 *
 * 只在 Server Action / 服务端调用，key 不会下发到浏览器。
 */
import { getSetting, setSetting, encryptSecret, decryptSecret, maskSecret } from "./settings";
import { getBusiness } from "./business";

export const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
export const DEFAULT_MODEL = "deepseek-chat";

export type LlmConfig = { apiKey: string; baseUrl: string; model: string };

const LLM_KEY = "llm";
type StoredLlm = { baseUrl?: string; model?: string; apiKeyEnc?: string };

const normBase = (u: string | undefined) => (u && u.trim() ? u.trim().replace(/\/+$/, "") : DEFAULT_BASE_URL);

/** 当前生效的配置；null 表示 AI 未启用 */
export async function getLlmConfig(): Promise<LlmConfig | null> {
  const stored = await getSetting<StoredLlm>(LLM_KEY);
  if (stored?.apiKeyEnc) {
    const apiKey = decryptSecret(stored.apiKeyEnc);
    // 解不出来（AUTH_SECRET 换了）就当没配，落到环境变量
    if (apiKey) return { apiKey, baseUrl: normBase(stored.baseUrl), model: stored.model?.trim() || DEFAULT_MODEL };
  }
  if (process.env.LLM_API_KEY) {
    return {
      apiKey: process.env.LLM_API_KEY,
      baseUrl: normBase(process.env.LLM_BASE_URL),
      model: process.env.LLM_MODEL?.trim() || DEFAULT_MODEL,
    };
  }
  return null;
}

/** AI 能力是否可用。页面用它决定是否渲染 AI 入口 */
export async function llmEnabled(): Promise<boolean> {
  return (await getLlmConfig()) !== null;
}

/** 给设置页看的状态：不含明文 key */
export async function describeLlmConfig(): Promise<{
  source: "ui" | "env" | null;
  baseUrl: string;
  model: string;
  keyMasked: string | null;
}> {
  const stored = await getSetting<StoredLlm>(LLM_KEY);
  const uiKey = stored?.apiKeyEnc ? decryptSecret(stored.apiKeyEnc) : null;
  if (uiKey) {
    return { source: "ui", baseUrl: normBase(stored?.baseUrl), model: stored?.model?.trim() || DEFAULT_MODEL, keyMasked: maskSecret(uiKey) };
  }
  if (process.env.LLM_API_KEY) {
    return {
      source: "env",
      baseUrl: normBase(process.env.LLM_BASE_URL),
      model: process.env.LLM_MODEL?.trim() || DEFAULT_MODEL,
      keyMasked: maskSecret(process.env.LLM_API_KEY),
    };
  }
  return { source: null, baseUrl: stored?.baseUrl?.trim() || DEFAULT_BASE_URL, model: stored?.model?.trim() || DEFAULT_MODEL, keyMasked: null };
}

/**
 * 保存界面配置。apiKey 传空表示"不改 key"，只更新地址与模型——
 * 界面上 key 只回显尾 4 位，用户改个模型名不该被迫重新粘一遍 key。
 */
export async function saveLlmConfig(input: { baseUrl: string; model: string; apiKey?: string | null }): Promise<void> {
  const stored = (await getSetting<StoredLlm>(LLM_KEY)) ?? {};
  const next: StoredLlm = {
    baseUrl: normBase(input.baseUrl),
    model: input.model.trim() || DEFAULT_MODEL,
    apiKeyEnc: input.apiKey && input.apiKey.trim() ? encryptSecret(input.apiKey.trim()) : stored.apiKeyEnc,
  };
  await setSetting(LLM_KEY, next);
}

/** 清掉界面配置，回到环境变量（或未启用） */
export async function clearLlmConfig(): Promise<void> {
  await setSetting(LLM_KEY, {});
}

/** 设置页「测试连接」用：填了新 key 就用新的，没填就用已存的 */
export async function resolveLlmConfigForTest(input: { baseUrl: string; model: string; apiKey?: string | null }): Promise<LlmConfig | null> {
  let apiKey = input.apiKey?.trim() || null;
  if (!apiKey) {
    const stored = await getSetting<StoredLlm>(LLM_KEY);
    apiKey = (stored?.apiKeyEnc ? decryptSecret(stored.apiKeyEnc) : null) ?? process.env.LLM_API_KEY ?? null;
  }
  if (!apiKey) return null;
  return { apiKey, baseUrl: normBase(input.baseUrl), model: input.model.trim() || DEFAULT_MODEL };
}

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
  /**
   * false = 关掉推理模型的思维链（DeepSeek 的 thinking 参数）。
   * agent 的每步决策只是选工具、填参数，让它"想"一分钟是浪费：真实测过同一段
   * 上下文开着思维链 24~73 秒、关掉 3 秒。最终回答仍开着，质量要紧。
   * 网关不认这个参数时会 4xx，调用方降级重试时去掉它。
   */
  thinking?: false;
};

const DEFAULT_MAX_TOKENS = 4000;

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function chatRaw(cfg: LlmConfig, messages: ChatMessage[], opts: ChatOpts, useJsonFormat: boolean, stream: boolean): Promise<Response> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  if (useJsonFormat) body.response_format = { type: "json_object" };
  if (opts.thinking === false) body.thinking = { type: "disabled" };
  if (stream) body.stream = true;
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 60_000)]) : AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  if (!res.ok) {
    const errText = (await res.text()).slice(0, 300);
    throw new Error(`接口返回 ${res.status}：${errText}`);
  }
  return res;
}

async function chatOnce(cfg: LlmConfig, system: string, prompt: string, opts: ChatOpts, useJsonFormat: boolean): Promise<string> {
  return chatMessagesOnce(cfg, [{ role: "system", content: system }, { role: "user", content: prompt }], opts, useJsonFormat);
}

async function chatMessagesOnce(cfg: LlmConfig, messages: ChatMessage[], opts: ChatOpts, useJsonFormat: boolean): Promise<string> {
  const res = await chatRaw(cfg, messages, opts, useJsonFormat, false);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * 多轮对话版的 JSON 调用：给 agent 循环用（system + 历史 + 工具结果）。
 * 同样带「不支持 json_object 就降级」和「坏 JSON 重试一次」两道保险。
 */
export async function chatMessagesJSON(messages: ChatMessage[], opts: ChatOpts = {}): Promise<unknown> {
  const cfg = await getLlmConfig();
  if (!cfg) throw new Error("AI 功能未启用：请管理员到「设置管理 → AI 接入」填写接口地址与 API Key");
  let content: string;
  try {
    content = await chatMessagesOnce(cfg, messages, opts, true);
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw e.name === "AbortError" ? e : new Error("AI 响应超时，请稍后重试");
    // 网关不认 response_format / thinking 时是 4xx：两个都去掉再试一次
    console.warn(`[llm] JSON 调用失败，降级重试：${e instanceof Error ? e.message.slice(0, 160) : e}`);
    content = await chatMessagesOnce(cfg, messages, { ...opts, thinking: undefined }, false);
  }
  try {
    return JSON.parse(stripCodeFence(content));
  } catch {
    const retry = await chatMessagesOnce(cfg, [...messages, { role: "assistant", content }, { role: "user", content: "你上一次的输出不是合法 JSON，请只输出严格合法的 JSON。" }], opts, true).catch(() =>
      chatMessagesOnce(cfg, messages, opts, false),
    );
    try {
      return JSON.parse(stripCodeFence(retry));
    } catch {
      throw new Error(`AI 返回内容不是合法 JSON：${retry.slice(0, 200)}`);
    }
  }
}

/**
 * 流式文本：逐 token 回调，给最终回答用——人看到字一个个出来，而不是等十几秒砸出一整块。
 * 网关不支持 stream 时（响应不是事件流）退化为一次性返回。
 */
export async function chatTextStream(messages: ChatMessage[], opts: ChatOpts, onToken: (text: string) => void): Promise<string> {
  const cfg = await getLlmConfig();
  if (!cfg) throw new Error("AI 功能未启用");
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
  let buf = "";
  let full = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const t = j.choices?.[0]?.delta?.content;
        if (t) {
          full += t;
          onToken(t);
        }
      } catch {
        /* 半截 JSON，等下一段 */
      }
    }
  }
  return full.trim();
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
    throw new Error("AI 功能未启用：请管理员到「设置管理 → AI 接入」填写接口地址与 API Key");
  }
  const system = buildSystemPrompt((await getBusiness()).brief);

  let content: string;
  try {
    content = await chatOnce(cfg, system, prompt, opts, true);
  } catch (e) {
    // 网关不支持 response_format 时表现为 4xx，降级为普通调用再试一次；
    // 网络/超时类错误也顺带走这条兜底（多花一次调用，换少一类需要人排查的失败）
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new Error("AI 响应超时，请稍后重试");
    }
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
      await chatOnce(cfg, system, repairPrompt, opts, true).catch(() => chatOnce(cfg, system, repairPrompt, opts, false)),
    );
    try {
      return JSON.parse(retried);
    } catch {
      throw new Error(`AI 返回内容不是合法 JSON：${retried.slice(0, 200)}`);
    }
  }
}
