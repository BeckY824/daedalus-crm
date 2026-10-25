/**
 * 模型修过一次还是没回合法 JSON（10-24 质量审 #146 提的）：以前错误信息是「AI 返回内容不是合法 JSON：<模型原文 200 字>」，
 * /api/ai/stream 原样摆到界面上，原文里可能就是客户资料。现在只说「AI 返回格式不对，请重试」，日志只记字数。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/settings", () => ({ getSetting: async () => null, setSetting: async () => {} }));

const 原始fetch = globalThis.fetch;
const 原文 = "好的，王同学的手机号 13800000000，下面是话术";

beforeEach(() => {
  vi.resetModules();
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_BASE_URL = "https://relay.example.com/v1";
  process.env.LLM_MODEL = "plain-model";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 原文 }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = 原始fetch;
  delete process.env.LLM_API_KEY;
  vi.restoreAllMocks();
});

async function 抓日志(跑: () => Promise<unknown>) {
  const 行: string[] = [];
  for (const k of ["log", "info", "warn", "error"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void 行.push(a.map(String).join(" ")));
  const e = await 跑().then(
    () => null,
    (x: unknown) => x as Error,
  );
  return { e, 行 };
}

describe("JSON 修过一次还坏", () => {
  it("chatMessagesJSON：错误信息是人话、不带原文，日志也不带", async () => {
    const { chatMessagesJSON, JSON格式不对 } = await import("@/lib/llm");
    const { e, 行 } = await 抓日志(() => chatMessagesJSON([{ role: "user", content: "x" }]));
    expect(e?.message).toBe(JSON格式不对);
    expect(行.join("\n")).not.toContain("13800000000");
  });

  it("chatJSON：同上", async () => {
    const { chatJSON, JSON格式不对 } = await import("@/lib/llm");
    const { e, 行 } = await 抓日志(() => chatJSON("x"));
    expect(e?.message).toBe(JSON格式不对);
    expect(行.join("\n")).not.toContain("13800000000");
  });
});
