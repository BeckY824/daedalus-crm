/**
 * 「这个模型认不认 thinking 参数」这个试探结论，记的是**上游**的行为，
 * 不是模型名的行为。
 *
 * 这张表是进程级的，而托管版一个进程伺候所有工作区。原来只按模型名记，
 * 于是 A 工作区对着自己的中转站试出来的结论，会套到 B 工作区头上——
 * 同一个「deepseek-chat」在两家中转站上完全可能一家能关思维链、一家不能。
 * 那样 B 要么白发一个注定被 400 的参数（每次都要先失败再重试），
 * 要么在另一张表上被凭空多扣 2500 的思考预算。
 *
 * 反过来同一个上游就该共享：那本来就是同一个服务，试一次的结论对谁都成立——
 * 这层缓存存在的理由正是这个。所以不按工作区分，按上游分。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type 记录 = { url: string; body: Record<string, unknown> };

/** 装一个假上游：只有指定的地址会拒绝 thinking，并把每次请求记下来 */
function 假上游(拒绝thinking: string) {
  const 收到: 记录[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    收到.push({ url: String(url), body });
    if (body.thinking && String(url).startsWith(拒绝thinking)) {
      return new Response(`{"error":"thinking not supported"}`, { status: 400 });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }),
      { status: 200 },
    );
  });
  return 收到;
}

const 甲 = "https://jia.example/v1";
const 乙 = "https://yi.example/v1";

beforeEach(async () => {
  const { 重置模型探测, clearLlmConfig } = await import("@/lib/llm");
  重置模型探测();
  // 让配置一定来自环境变量，这样每条用例能自己指定「上游是谁」
  await clearLlmConfig();
  process.env.LLM_API_KEY = "FAKE-TEST-KEY-9000";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_BASE_URL;
});

/** 走真实那条路：agent 的每步决策就是这么调的（run.ts 里带着 thinking: false） */
async function 问一次(base: string, model: string) {
  const { chatMessagesJSON } = await import("@/lib/llm");
  process.env.LLM_BASE_URL = base;
  await chatMessagesJSON([{ role: "user", content: "hi" }], { model, thinking: false, maxTokens: 100 }).catch(() => null);
}

describe("试探结论按上游分，不按模型名分", () => {
  it("甲家中转站拒绝 thinking，不影响乙家的同名模型", async () => {
    const 收到 = 假上游(甲);
    const 模型 = "deepseek-chat";

    await 问一次(甲, 模型); // 第一次带着 thinking 被 400，记下结论，降级重试
    await 问一次(甲, 模型);
    const 甲的 = 收到.filter((r) => r.url.startsWith(甲));
    expect(甲的[0].body.thinking, "第一次要试一下").toBeDefined();
    expect(甲的.at(-1)!.body.thinking, "被拒过之后就不该再带").toBeUndefined();

    await 问一次(乙, 模型);
    const 乙的 = 收到.filter((r) => r.url.startsWith(乙));
    expect(乙的[0].body.thinking, "乙家是另一个上游，不该继承甲家的结论").toBeDefined();
  });

  it("同一个上游同一个模型，结论共享——这层缓存的意义就在这儿", async () => {
    const 收到 = 假上游(甲);
    await 问一次(甲, "m");
    await 问一次(甲, "m");
    await 问一次(甲, "m");
    const 带了thinking = 收到.filter((r) => r.body.thinking).length;
    expect(带了thinking, "只该在第一次试一下，之后不再试").toBe(1);
  });

  it("末尾多个斜杠不算另一个上游", async () => {
    const 收到 = 假上游(甲);
    await 问一次(甲, "m");
    await 问一次(甲 + "/", "m");
    expect(收到.filter((r) => r.body.thinking).length, "同一个地址，只是多了个斜杠").toBe(1);
  });
});
