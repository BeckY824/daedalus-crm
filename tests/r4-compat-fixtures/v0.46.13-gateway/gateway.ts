/**
 * 模型网关的配置。
 *
 * 桌面端把数据留在用户机器上，唯一还需要云端的就是模型调用——用户没有自己的
 * API Key，我们替他转发，并按账号扣免费次数。网关对外是标准的 OpenAI 兼容接口，
 * 所以桌面端的 AI 设置就是「接口地址填我们、Key 填设备令牌」，llm.ts 一行不用改。
 *
 * 三个环境变量，缺 Key 就等于整个网关不存在（路由一律 404）：
 *   GATEWAY_API_KEY   上游（中转站）的 Key。**只在服务端**，绝不下发
 *   GATEWAY_BASE_URL  上游地址，默认 DeepSeek 官方
 *   GATEWAY_MODELS    允许的模型，逗号分隔，第一个是默认。可用 | 加一句备注
 *
 * 为什么要模型白名单：网关花的是我们的钱。不限的话，一个改了 model 字段的请求
 * 就能把免费额度花在最贵的模型上——一次扣一次的账，成本却能差两个数量级。
 */

export const 默认上游 = "https://api.deepseek.com/v1";

/** 单次请求允许的最大输出长度。上限由我们定，客户端传得再大也夹到这里 */
export const 最大输出长度 = 8000;

export type 模型项 = { id: string; note?: string };

export type 网关配置 = {
  baseUrl: string;
  apiKey: string;
  models: 模型项[];
};

/** 解析 "glm-5.3-flash|限时免费,deepseek-chat" 这种写法。和 LLM_MODELS 同一格式 */
export function 解析模型表(raw: string | undefined): 模型项[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, note] = s.split("|");
      return { id: id.trim(), note: note?.trim() || undefined };
    })
    .filter((m) => m.id);
}

/** 网关没配就返回 null，调用方一律 404——自部署版和桌面端里这些路由不该存在 */
export function 读网关配置(env: NodeJS.ProcessEnv = process.env): 网关配置 | null {
  const apiKey = env.GATEWAY_API_KEY?.trim();
  if (!apiKey) return null;
  const models = 解析模型表(env.GATEWAY_MODELS);
  return {
    apiKey,
    baseUrl: (env.GATEWAY_BASE_URL?.trim() || 默认上游).replace(/\/+$/, ""),
    // 一个都没配就只认默认模型，避免"白名单为空 = 全部放行"这种最危险的默认
    models: models.length ? models : [{ id: "deepseek-chat" }],
  };
}

/**
 * 把客户端传来的请求体收拾干净再转发。
 *
 * 只保留我们认识的字段：客户端能传什么就转什么的话，上游的计费参数
 * （比如 n=10、超长 max_tokens）就等于对外开放了。
 */
export function 收拾请求体(
  body: Record<string, unknown>,
  cfg: 网关配置,
): { ok: true; body: Record<string, unknown>; stream: boolean } | { ok: false; error: string } {
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : cfg.models[0].id;
  if (!cfg.models.some((m) => m.id === model)) {
    return { ok: false, error: `不支持的模型 ${model}，可用：${cfg.models.map((m) => m.id).join("、")}` };
  }
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return { ok: false, error: "messages 不能为空" };

  const out: Record<string, unknown> = { model, messages };
  if (typeof body.temperature === "number") out.temperature = Math.max(0, Math.min(2, body.temperature));
  const mt = typeof body.max_tokens === "number" ? body.max_tokens : 最大输出长度;
  out.max_tokens = Math.max(1, Math.min(最大输出长度, Math.floor(mt)));
  // 这两个是 llm.ts 会发的：JSON 模式、关思维链。原样透传，上游不认时由它自己报错
  if (body.response_format) out.response_format = body.response_format;
  if (body.thinking) out.thinking = body.thinking;
  const stream = body.stream === true;
  if (stream) {
    out.stream = true;
    // 让上游在流的最后带上 token 用量，将来要按 token 计费时就有数据了
    out.stream_options = { include_usage: true };
  }
  return { ok: true, body: out, stream };
}
