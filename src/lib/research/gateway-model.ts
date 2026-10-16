/**
 * 背调的分析直接打我们的模型网关（/api/gateway/v1/chat/completions），不走 lib/llm.ts 的「当前配置」。
 *
 * 为什么不复用 llm.ts：那边读的是这台机器的 AI 设置——填了自己 Key 的人，llm.ts 打的是他自己的上游。
 * 10-16 总控定背调的搜索和分析一律用我们的服务、照价扣，所以这里固定用云端账号的设备令牌打我们的网关，
 * 每次都带这次背调的编号（X-Question-Id = runId）：网关认得是同一笔、不另扣，背调专用模型也只对这一笔放行。
 *
 * 只做背调要的两件事：带工具问一步、要一段 JSON。超时 / 5xx 原样重发一次（retry.ts；网关对失败的那次会退，重发不多扣）。
 * 每次都带 X-Research-Stage（这是 6 步里的哪一步）：服务器看到最后一步交出去了，才算这次背调跑完（credits.ts 的 收尾背调）。
 */
import type { 模型调用 } from "./run";
import { 背调超时, 重发一次 } from "./retry";

type 配置 = { baseUrl: string; apiKey: string };

/** 网关的报错是 OpenAI 那套 { error: { message } }，那句是中文，原样交出去 */
function 认错(status: number, t: string): Error {
  let m = "";
  try {
    m = (JSON.parse(t) as { error?: { message?: string } }).error?.message ?? "";
  } catch {
    /* 不是 JSON */
  }
  return Object.assign(new Error(m || `AI 服务出错了（${status}），稍后再试`), { status });
}

export function 网关模型(cfg: 配置, 当前模型: () => string | undefined): 模型调用 {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const 发 = async (body: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number; requestId?: string; maxTokens?: number; temperature?: number; model?: string; researchStage?: string }) => {
    const j = await 重发一次(
      async (signal) => {
        const res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
            ...(opts.requestId ? { "X-Question-Id": opts.requestId } : {}),
            ...(opts.researchStage ? { "X-Research-Stage": opts.researchStage } : {}),
            "X-Feature": "research",
          },
          // 编排按角色传模型名（摘要用 mini、最后打分写报告用 gpt-5.5）；没传就用通道上的报告模型
          body: JSON.stringify({ model: opts.model ?? 当前模型(), temperature: opts.temperature ?? 0, max_tokens: opts.maxTokens ?? 2000, ...body }),
          signal,
        });
        const t = await res.text();
        if (!res.ok) throw 认错(res.status, t);
        return JSON.parse(t) as { choices?: { message?: { content?: string | null; tool_calls?: unknown[] } }[] };
      },
      opts.timeoutMs ?? 背调超时.模型每次,
      opts.signal,
    );
    return j.choices?.[0]?.message ?? {};
  };
  return {
    async tools(messages, tools, opts) {
      const m = await 发({ messages, tools }, opts);
      return { toolCalls: (m.tool_calls ?? []) as never, text: (m.content ?? "").trim() };
    },
    async json(messages, opts) {
      let m;
      try {
        m = await 发({ messages, response_format: { type: "json_object" } }, opts);
      } catch (e) {
        // 上游不认 response_format 是 4xx：去掉再要一次
        if ((e as { status?: number }).status !== 400) throw e;
        m = await 发({ messages }, opts);
      }
      const s = (m.content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      try {
        return JSON.parse(s || "{}");
      } catch {
        throw new Error(`AI 返回内容不是合法 JSON：${s.slice(0, 120)}`);
      }
    },
  };
}
