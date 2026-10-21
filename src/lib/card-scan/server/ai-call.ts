/**
 * 服务器这头调模型整理名片（提示词、验收在 lib/card-scan/ai.ts，两头共用）。
 *
 * 连哪：CARD_SCAN_AI_BASE_URL / CARD_SCAN_AI_KEY 配了就用它；没配就借模型网关的上游（GATEWAY_BASE_URL / GATEWAY_API_KEY，
 * 和背调同一个中转站）。模型 CARD_SCAN_AI_MODEL，默认见 默认模型。都没有 Key、或 CARD_SCAN_AI_OFF=1 → 返回 null，手机用规则。
 * 不扣次数、不走背调计费（2026-10-20 用户定「免费不扣次数」）。
 * 名片文字只在这次请求里：不落盘、不打日志（出错只记状态码）。
 */
import { 读网关配置 } from "@/lib/gateway";
import { AI系统提示, AI用户消息, 验AI回答, type AI回答, type 名片行 } from "../ai";

/**
 * 10-21 在 56 张测试集上比过（05-反馈与复盘/名片识别-改进-20261020/结果.md）：真名片 5 张全对、一张约 1.5 分钱、中位 3 秒。
 * gpt-5.4-nano 便宜 5 倍但翻译漏得多；gpt-5-mini 准确率差不多但中位 6.5 秒、最慢 13 秒，超过 超时毫秒
 */
export const 默认模型 = "gpt-5.4-mini";
/** 超过就当没有：人在等着看表单，规则的结果已经在手上了 */
export const 超时毫秒 = 8000;

export function 整理配置(env: NodeJS.ProcessEnv = process.env): { baseUrl: string; apiKey: string; model: string } | null {
  if (env.CARD_SCAN_AI_OFF?.trim() === "1") return null;
  const model = env.CARD_SCAN_AI_MODEL?.trim() || 默认模型;
  const key = env.CARD_SCAN_AI_KEY?.trim();
  if (key) return { apiKey: key, baseUrl: (env.CARD_SCAN_AI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""), model };
  const 网关 = 读网关配置(env);
  return 网关 ? { apiKey: 网关.apiKey, baseUrl: 网关.baseUrl, model } : null;
}

/** 问一次。超时、非 200、不是 JSON、验不过都返回 null（调用方用规则），从不抛 */
export async function AI整理名片(
  行们: 名片行[],
  行业们: readonly string[],
  设: { 抓?: typeof fetch; env?: NodeJS.ProcessEnv; 超时?: number } = {},
): Promise<AI回答 | null> {
  const cfg = 整理配置(设.env);
  if (!cfg || !行们.length) return null;
  try {
    const r = await (设.抓 ?? fetch)(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "system", content: AI系统提示(行业们) }, { role: "user", content: AI用户消息(行们) }],
        response_format: { type: "json_object" },
        max_tokens: 2000,
        // GPT-5 系列默认想得久：摆格子用不着，low 快一倍
        ...(/^(gpt-5|o\d)/.test(cfg.model) ? { reasoning_effort: "low" } : {}),
      }),
      signal: AbortSignal.timeout(设.超时 ?? 超时毫秒),
    });
    if (!r.ok) { console.warn(`[card-scan-ai] 模型回 ${r.status}，用规则`); return null; }
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return 验AI回答(JSON.parse(j.choices?.[0]?.message?.content ?? "null"), 行们.length, 行业们);
  } catch (e) {
    console.warn(`[card-scan-ai] 没拿到（${e instanceof Error ? e.name : "未知"}），用规则`);
    return null;
  }
}
