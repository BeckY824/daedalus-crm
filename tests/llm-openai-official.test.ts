/**
 * 设置里选「OpenAI（GPT）」= 直连 api.openai.com。它的 gpt-5 系列不认 max_tokens、不认改 temperature、
 * 不认 thinking——照中转站那套发，「测试连接」第一下就是 400。
 * 中转站上同名的 gpt-5.5 不受影响，照旧发 max_tokens。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/settings", () => ({ getSetting: async () => null, setSetting: async () => {} }));

const 原始fetch = globalThis.fetch;

function 回应(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function 抓请求() {
  const 请求: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    请求.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return 回应({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] });
  }) as typeof fetch;
  return 请求;
}

beforeEach(() => {
  vi.resetModules();
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "gpt-5.5";
});

afterEach(() => {
  globalThis.fetch = 原始fetch;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
});

describe("直连 OpenAI 官方接口", () => {
  it("发 max_completion_tokens（带思考预算），不发 max_tokens / temperature / thinking", async () => {
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    const 请求 = 抓请求();
    const { chatMessagesJSON } = await import("@/lib/llm");
    await chatMessagesJSON([{ role: "user", content: "x" }], { maxTokens: 1500, thinking: false, temperature: 0.2 });
    expect(请求).toHaveLength(1);
    expect(请求[0].max_completion_tokens).toBeGreaterThan(1500);
    expect(请求[0]).not.toHaveProperty("max_tokens");
    expect(请求[0]).not.toHaveProperty("temperature");
    expect(请求[0]).not.toHaveProperty("thinking");
  });

  it("中转站上同名的 gpt-5.5 照旧：max_tokens + temperature", async () => {
    process.env.LLM_BASE_URL = "https://relay.example.com/v1";
    const 请求 = 抓请求();
    const { chatMessagesJSON } = await import("@/lib/llm");
    await chatMessagesJSON([{ role: "user", content: "x" }], { maxTokens: 1500 });
    expect(请求[0].max_tokens).toBe(1500);
    expect(请求[0].temperature).toBe(0.3);
    expect(请求[0]).not.toHaveProperty("max_completion_tokens");
  });

  it("预设表里有 OpenAI 一家，地址认得回来", async () => {
    const { PROVIDERS, 认服务商 } = await import("@/lib/providers");
    const p = PROVIDERS.find((x) => x.id === "openai");
    expect(p?.baseUrl).toBe("https://api.openai.com/v1");
    expect(p?.models[0].id).toBe("gpt-5.5");
    expect(认服务商("https://api.openai.com/v1/")?.id).toBe("openai");
    // 默认那一家仍是 DeepSeek（首页、文案、E2E 都按它）
    expect(PROVIDERS[0].id).toBe("deepseek");
  });
});
