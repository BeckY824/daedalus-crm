/**
 * LLM 调用层 —— 任何 OpenAI 兼容接口（DeepSeek 官方、OpenAI、中转站、本地 Ollama…）。
 *
 * 用三个环境变量配置：
 *   LLM_API_KEY    必填；不配则 AI 能力整体隐藏，CRM 其余功能不受影响
 *   LLM_BASE_URL   默认 DeepSeek 官方 https://api.deepseek.com/v1
 *   LLM_MODEL      默认 deepseek-chat
 *
 * 几条用真实回归换来的规矩：
 *   1. 显式传 max_tokens 与超时——不传时实际上限取决于网关自己的默认值，
 *      不透明也不一致，"输出被截断"和"模型没遵循格式"两种失败会混在一起
 *   2. response_format=json_object 失败时降级为普通调用（部分网关不支持该参数）
 *   3. 返回内容先剥代码围栏再解析；仍不是合法 JSON 时带着原始输出重试一次
 *   4. API key 没配置时该能力整体不可用，但绝不影响 CRM 其余功能
 *
 * 只在 Server Action / 服务端调用，key 不会下发到浏览器。
 */

const BASE_URL = () => (process.env.LLM_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
const MODEL = () => process.env.LLM_MODEL || "deepseek-chat";

/** AI 能力是否可用（key 配没配）。页面用它决定是否渲染 AI 入口 */
export function llmEnabled(): boolean {
  return Boolean(process.env.LLM_API_KEY);
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

const SYSTEM_PROMPT =
  "你是 CRM 系统的录入与分析助手，服务教育培训行业的销售团队。" +
  "严格依据用户提供的信息作答，禁止编造事实。" +
  "必须只输出用户要求的 JSON，不要输出任何 JSON 之外的文字、解释或 Markdown 代码块标记。";

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
};

const DEFAULT_MAX_TOKENS = 4000;

async function chatOnce(prompt: string, opts: ChatOpts, useJsonFormat: boolean): Promise<string> {
  const body: Record<string, unknown> = {
    model: MODEL(),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  if (useJsonFormat) body.response_format = { type: "json_object" };

  const res = await fetch(`${BASE_URL()}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });

  if (!res.ok) {
    const errText = (await res.text()).slice(0, 300);
    throw new Error(`网关返回 ${res.status}：${errText}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * 调用模型并要求返回 JSON，返回已 parse 的对象。
 * 抛出的 Error 带中文信息，可直接展示给使用者。
 */
export async function chatJSON(prompt: string, opts: ChatOpts = {}): Promise<unknown> {
  if (!llmEnabled()) {
    throw new Error("AI 功能未启用：服务端未配置 LLM_API_KEY");
  }

  let content: string;
  try {
    content = await chatOnce(prompt, opts, true);
  } catch (e) {
    // 网关不支持 response_format 时表现为 4xx，降级为普通调用再试一次；
    // 网络/超时类错误也顺带走这条兜底（多花一次调用，换少一类需要人排查的失败）
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new Error("AI 响应超时，请稍后重试");
    }
    content = await chatOnce(prompt, opts, false);
  }

  const cleaned = stripCodeFence(content);
  try {
    return JSON.parse(cleaned);
  } catch {
    // 带着上次的坏输出重试一次，让模型自己修
    const repairPrompt =
      `${prompt}\n\n【注意】你上一次的输出不是合法 JSON：\n${content.slice(0, 500)}\n` +
      "请只输出严格合法的 JSON，不要输出任何其他文字。";
    const retried = stripCodeFence(await chatOnce(repairPrompt, opts, true).catch(() => chatOnce(repairPrompt, opts, false)));
    try {
      return JSON.parse(retried);
    } catch {
      throw new Error(`AI 返回内容不是合法 JSON：${retried.slice(0, 200)}`);
    }
  }
}
