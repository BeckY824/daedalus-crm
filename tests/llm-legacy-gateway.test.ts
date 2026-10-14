import { it, expect, vi, afterEach } from "vitest";
vi.mock("@/lib/llm-config", () => ({ getLlmConfig: async () => ({ apiKey: "legacy-test-key", baseUrl: "https://legacy.example.test/api/gateway/v1", model: "m" }) }));
afterEach(() => vi.unstubAllGlobals());
it("旧网关转发上游402不能缓存为用户零额度；恢复后可继续请求", async () => {
  const { chatTools, AI报错人话 } = await import("@/lib/llm");
  const error = JSON.stringify({ error: { message: '上游模型接口返回 402：{"error":"Insufficient Balance"}', type: "gateway_error" } });
  let count = 0;
  vi.stubGlobal("fetch", async () => ++count === 1
    ? new Response(error, { status: 402, headers: { "Content-Type": "application/json" } })
    : new Response(JSON.stringify({ choices: [{ message: { content: "恢复了", tool_calls: [] }, finish_reason: "stop" }] })));
  await expect(chatTools([{ role: "user", content: "一" }], [], { requestId: "legacy-q1" })).rejects.toThrow();
  expect((await chatTools([{ role: "user", content: "二" }], [], { requestId: "legacy-q2" })).text).toBe("恢复了");
  expect(count).toBe(2);
  expect(AI报错人话(402, error)).not.toMatch(/Insufficient|\{|次数用完/);
});
it("旧网关的上游401/404提示服务故障，不冒充用户登录失败或显示英文协议", async () => {
  const { AI报错人话 } = await import("@/lib/llm");
  for (const status of [401, 404]) {
    expect(AI报错人话(status, JSON.stringify({ error: { message: `上游模型接口返回 ${status}：{"error":"Authentication Fails / Model Not Exist"}` } }))).not.toMatch(/Authentication|Model Not Exist|\{|退出登录|凭据/);
  }
});
