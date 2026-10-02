/**
 * 复查 692dd81「AI 报错说人话」：判断「走的是不是我们的网关」用的是 本地模式()，不是这次请求的 baseUrl。
 * 桌面端在设置里填了自己的 Key（BYOK，llm-config 里设置页的 Key 优先于云端令牌）时，
 * 测连接 / 调用报的是**他自己那家**的错，却被翻成网关口径：
 *   401 → 「AI 登录凭据失效了，请在设置里退出登录再登录一次」——退出重登我们的账号修不了他自己的 Key；
 *   404（模型名 / 地址填错）→ 「AI 接口没接受这次请求（404），稍后再试」——原文没了，他没法自己查。
 * 注释里写的口径是「自己填 Key 的照旧给原文」。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { testLlm } from "@/lib/llm";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DESKTOP_LOCAL;
});

const 上游回 = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

describe("复查：桌面端自填 Key 的报错被翻成网关口径", () => {
  it("401（自己的 Key 错了）：不该叫人去退出重登我们的账号，应给原文", async () => {
    process.env.DESKTOP_LOCAL = "1";
    上游回(401, { error: { message: "Incorrect API key provided", type: "invalid_request_error" } });
    const r = await testLlm({ apiKey: "sk-mine", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" });
    expect(r.ok ? "" : r.error).not.toContain("退出登录"); // 实际：AI 登录凭据失效了，请在设置里退出登录再登录一次
  });
  it("404（模型名填错）：应保留上游原文让人自己查", async () => {
    process.env.DESKTOP_LOCAL = "1";
    上游回(404, { error: { message: "Model Not Exist", type: "invalid_request_error" } });
    const r = await testLlm({ apiKey: "sk-mine", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chta" });
    expect(r.ok ? "" : r.error).toContain("Model Not Exist"); // 实际：AI 接口没接受这次请求（404），稍后再试…
  });
});
