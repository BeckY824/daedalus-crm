/**
 * 推理模型的两个坑。都是线上真实发生过的，都不是"模型不听话"。
 *
 * 1. 中转站上有的模型**始终思考**，带 thinking:{type:"disabled"} 直接 400。
 *    光靠调用方 catch 重试不够：agent 循环最多 6 步，每步都要先失败一次；
 *    更糟的是 chatMessagesJSON 里「模型没输出合法 JSON」那条恢复路径用的还是
 *    原始 opts，等于把刚失败的参数又加回去，于是 400 冒到界面上。
 *
 * 2. max_tokens 是「思考 + 正文」共用的预算。实测一个只要求输出 {"ok":true}
 *    的请求就烧掉 92 个 reasoning token。额度不够时 finish_reason 是 length、
 *    正文被截断，再交给 JSON.parse 就报「返回内容不是合法 JSON」——
 *    把「额度不够」说成「模型不听话」，排查方向全错。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/settings", () => ({ getSetting: async () => null, setSetting: async () => {} }));

const 原始fetch = globalThis.fetch;

function 回应(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const 正常回答 = {
  choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
  usage: { completion_tokens_details: { reasoning_tokens: 92 } },
};

beforeEach(() => {
  vi.resetModules();
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_BASE_URL = "https://relay.example.com/v1";
  process.env.LLM_MODEL = "always-thinking-model";
});

afterEach(() => {
  globalThis.fetch = 原始fetch;
  delete process.env.LLM_API_KEY;
});

describe("模型不认 thinking 参数", () => {
  it("被拒一次之后，后续请求不再带这个参数", async () => {
    const 请求: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      请求.push(body);
      if (body.thinking) return 回应({ error: { message: "该模型始终思考，不支持关闭思考" } }, 400);
      return 回应(正常回答);
    }) as typeof fetch;

    const { chatMessagesJSON } = await import("@/lib/llm");
    await chatMessagesJSON([{ role: "user", content: "x" }], { thinking: false });
    await chatMessagesJSON([{ role: "user", content: "y" }], { thinking: false });
    await chatMessagesJSON([{ role: "user", content: "z" }], { thinking: false });

    // 第一次带了（探测），之后一次都不该再带
    expect(请求[0].thinking).toBeTruthy();
    expect(请求.slice(1).some((b) => b.thinking)).toBe(false);
    // 一共 4 个请求：第一次失败 + 它的重试，然后两次直接成功。
    // 要是每次都重新试探，会是 6 个——agent 跑 6 步就是 6 个白跑的往返
    expect(请求.length).toBe(4);
  });

  it("恢复路径不会把刚失败的参数加回去", async () => {
    let 第几次 = 0;
    const 带thinking的请求: number[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      第几次++;
      if (body.thinking) {
        带thinking的请求.push(第几次);
        return 回应({ error: { message: "不支持关闭思考" } }, 400);
      }
      // 第一次降级重试时返回不是 JSON 的内容，逼出「请只输出 JSON」那条恢复路径
      if (第几次 === 2) return 回应({ choices: [{ message: { content: "好的，我明白了" }, finish_reason: "stop" }] });
      return 回应(正常回答);
    }) as typeof fetch;

    const { chatMessagesJSON } = await import("@/lib/llm");
    const r = await chatMessagesJSON([{ role: "user", content: "x" }], { thinking: false });

    expect(r).toEqual({ ok: true });
    // 只有最开始那次探测带了参数；恢复路径里一次都不许再带
    expect(带thinking的请求).toEqual([1]);
  });
});

describe("思考占掉 max_tokens", () => {
  it("见过思维链之后，后续请求的预算要加上思考那一笔", async () => {
    const 额度: number[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      额度.push(Number(body.max_tokens));
      return 回应(正常回答);
    }) as typeof fetch;

    const { chatMessagesJSON } = await import("@/lib/llm");
    await chatMessagesJSON([{ role: "user", content: "x" }], { maxTokens: 1500 });
    await chatMessagesJSON([{ role: "user", content: "y" }], { maxTokens: 1500 });

    // 第一次按调用方说的给，第二次发现它会思考，额外加预算
    expect(额度[0]).toBe(1500);
    expect(额度[1]).toBeGreaterThan(1500);
  });

  it("被长度截断时报「截断」，不能报成「返回内容不是合法 JSON」", async () => {
    globalThis.fetch = (async () =>
      回应({
        choices: [{ message: { content: '{"ok":tr' }, finish_reason: "length" }],
        usage: { completion_tokens_details: { reasoning_tokens: 92 } },
      })) as typeof fetch;

    const { chatMessagesJSON } = await import("@/lib/llm");
    // 两条路都被截断时，最终抛出来的话得指向真正的原因
    await expect(chatMessagesJSON([{ role: "user", content: "x" }], { maxTokens: 100 })).rejects.toThrow(/截断/);
  });
});
