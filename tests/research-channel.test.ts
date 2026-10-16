/**
 * 背调的通道（lib/research/channel.ts）和背调的模型调用（gateway-model.ts）：桌面端怎么去我们服务器上问价、搜、
 * 出错怎么说、背调用哪个模型，以及「自己填了 Key 的也走我们的网关、照价扣」（10-16 总控定）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { 云端通道, 挑背调模型 } from "@/lib/research/channel";
import { 收拾请求体, 背调模型表 } from "@/lib/gateway";

afterEach(() => vi.unstubAllGlobals());

describe("挑背调模型：只用 GPT / Claude，GPT 优先（10-16 总控定）", () => {
  it.each([
    [["deepseek-v4.1-flash", "gpt-5.5", "claude-sonnet-5.5|备注"], "gpt-5.5"],
    [["deepseek-v4.1-flash", "claude-haiku-5.5", "claude-sonnet-5.5"], "claude-sonnet-5.5"],
    [["deepseek-v4.1-flash", "claude-haiku-5.5"], "claude-haiku-5.5"],
    [["deepseek-v4.1-flash"], undefined],
  ])("%j → %s", (models, 期望) => {
    expect(挑背调模型(models as string[])).toBe(期望);
  });
});

describe("云端通道", () => {
  const cfg = { baseUrl: "https://crm.example/api/gateway/v1", apiKey: "dev-token", models: ["deepseek-v4.1-flash"] };

  it("问价：扣几次、还剩几次都听服务器的（改价不用发版）；测试账号不报余额", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ 扣次: 60, 还剩: 23 }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await 云端通道(cfg).价目()).toEqual({ 扣次: 60, 还剩: 23, 不限: undefined });
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("https://crm.example/api/gateway/v1/research/price");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ 扣次: 60, 还剩: 999, 不限: true }), { status: 200 })));
    expect(await 云端通道(cfg).价目()).toMatchObject({ 还剩: null, 不限: true });
  });

  it("开始：打 /research/start，设备令牌当 Bearer；402 把网关那句中文原样交回", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "背调要 60 次，你还剩 23 次，这次没扣。" } }), { status: 402 }));
    vi.stubGlobal("fetch", fetch);
    const r = await 云端通道(cfg).开始("run-1");
    expect(r).toEqual({ ok: false, error: "背调要 60 次，你还剩 23 次，这次没扣。" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://crm.example/api/gateway/v1/research/start");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer dev-token");
  });

  it("开始以后：扣了几次、用哪个模型都听服务器的", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, 扣了: 60, 还剩: 20, 模型: "gpt-5.5" }), { status: 200 })));
    const 通道 = 云端通道(cfg);
    expect(通道.模型).toBeUndefined();
    await 通道.开始("run-2");
    expect(通道).toMatchObject({ 扣次: 60, 模型: "gpt-5.5" });
  });

  it("搜索 / 读页回来的「到现在花了多少」记在通道上（编排据此到 4 元停手）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [], 花费: { 已花元: 1.2, 上限元: 4 } }), { status: 200 })));
    const 通道 = 云端通道(cfg);
    await 通道.搜索("run-3", "x");
    expect(通道.花费).toEqual({ 已花元: 1.2, 上限元: 4 });
  });

  it("服务器还没开通背调（404，老服务器）说人话", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not Found", { status: 404 })));
    await expect(云端通道(cfg).搜索("run-1", "x")).rejects.toThrow("服务器还没开通背调");
  });

  it("收尾失败不抛：报告照出，只是少记一笔", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await 云端通道(cfg).收尾("run-1", true, { searches: 1, pages: 0 })).toBeNull();
    warn.mockRestore();
  });

  it("背调的分析直接打我们的网关（不看本机填没填自己的 Key）：带这次背调的编号和 feature，模型用服务器定的", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/research/start")
        ? new Response(JSON.stringify({ ok: true, 扣了: 60, 还剩: 0, 模型: "gpt-5.5" }), { status: 200 })
        : new Response(JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    const 通道 = 云端通道(cfg);
    await 通道.开始("run-4");
    expect(await 通道.模型调用!.json([{ role: "user", content: "hi" }], { requestId: "run-4" })).toEqual({ a: 1 });
    const [url, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("https://crm.example/api/gateway/v1/chat/completions");
    expect(init.headers).toMatchObject({ Authorization: "Bearer dev-token", "X-Question-Id": "run-4", "X-Feature": "research" });
    expect(JSON.parse(String(init.body)).model).toBe("gpt-5.5");
  });
});

describe("背调专用模型：只在背调那一笔里放行，平时问答点名也不给", () => {
  const cfg = { baseUrl: "https://relay.example/v1", apiKey: "k", models: [{ id: "deepseek-v4.1-flash" }] };
  const 体 = { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] };

  it("不配 RESEARCH_MODELS：GPT 为主，Claude 备用", () => {
    expect(背调模型表({} as NodeJS.ProcessEnv)).toEqual(["gpt-5.5", "claude-sonnet-5.5"]);
    expect(背调模型表({ RESEARCH_MODELS: "claude-sonnet-5.5|备注,claude-haiku-5.5" } as unknown as NodeJS.ProcessEnv)).toEqual(["claude-sonnet-5.5", "claude-haiku-5.5"]);
  });

  it("平时点名 GPT：换成默认模型；背调那一笔：放行", () => {
    expect(收拾请求体(体, cfg)).toMatchObject({ ok: true, body: { model: "deepseek-v4.1-flash" } });
    expect(收拾请求体(体, cfg, 背调模型表({} as NodeJS.ProcessEnv))).toMatchObject({ ok: true, body: { model: "gpt-5.5" } });
  });
});
