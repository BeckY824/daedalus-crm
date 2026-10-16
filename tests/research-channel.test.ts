/**
 * 背调的通道（lib/research/channel.ts）：桌面端怎么去我们服务器上搜、出错怎么说、背调用哪个模型。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { 云端通道, 挑背调模型 } from "@/lib/research/channel";
import { 收拾请求体, 背调模型表 } from "@/lib/gateway";

afterEach(() => vi.unstubAllGlobals());

describe("挑背调模型：只用 GPT / Claude（10-16 用户定），Claude 优先", () => {
  it.each([
    [["deepseek-v4.1-flash", "gpt-5.5", "claude-sonnet-5.5|备注"], "claude-sonnet-5.5"],
    [["deepseek-v4.1-flash", "claude-haiku-5.5", "gpt-5.5"], "claude-haiku-5.5"],
    [["deepseek-v4.1-flash", "gpt-5.5"], "gpt-5.5"],
    [["deepseek-v4.1-flash"], undefined],
  ])("%j → %s", (models, 期望) => {
    expect(挑背调模型(models as string[])).toBe(期望);
  });
});

describe("云端通道", () => {
  const cfg = { baseUrl: "https://crm.example/api/gateway/v1", apiKey: "dev-token", models: ["deepseek-v4.1-flash", "claude-sonnet-5.5"] };

  it("走我们的模型扣 6 次、用 Claude；自己填了 Key 的扣 2 次、模型用他自己的", () => {
    expect(云端通道(cfg, true)).toMatchObject({ 扣次: 6, 模型: "claude-sonnet-5.5" });
    expect(云端通道(cfg, false)).toMatchObject({ 扣次: 2, 模型: undefined });
  });

  it("开始：打 /research/start，设备令牌当 Bearer；402 把网关那句中文原样交回", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "免费的 AI 次数已经用完（共 30 次）。" } }), { status: 402 }));
    vi.stubGlobal("fetch", fetch);
    const r = await 云端通道(cfg, true).开始("run-1");
    expect(r).toEqual({ ok: false, error: "免费的 AI 次数已经用完（共 30 次）。" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://crm.example/api/gateway/v1/research/start");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer dev-token");
    expect(JSON.parse(String(init.body))).toEqual({ runId: "run-1", 走我们的模型: true });
  });

  it("服务器还没开通背调（404，老服务器）说人话", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not Found", { status: 404 })));
    await expect(云端通道(cfg, true).搜索("run-1", "x")).rejects.toThrow("服务器还没开通背调");
  });

  it("收尾失败不抛：报告照出，只是少记一笔", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await 云端通道(cfg, true).收尾("run-1", true, { searches: 1, pages: 0 })).toBeNull();
    warn.mockRestore();
  });
});

describe("背调专用模型：只在背调那一笔里放行，平时问答点名也不给", () => {
  const cfg = { baseUrl: "https://relay.example/v1", apiKey: "k", models: [{ id: "deepseek-v4.1-flash" }] };
  const 体 = { model: "claude-sonnet-5.5", messages: [{ role: "user", content: "hi" }] };

  it("不配 RESEARCH_MODELS：Claude 优先，GPT 备用", () => {
    expect(背调模型表({} as NodeJS.ProcessEnv)).toEqual(["claude-sonnet-5.5", "gpt-5.5"]);
    expect(背调模型表({ RESEARCH_MODELS: "gpt-5.5|备注,claude-haiku-5.5" } as unknown as NodeJS.ProcessEnv)).toEqual(["gpt-5.5", "claude-haiku-5.5"]);
  });

  it("平时点名 Claude：换成默认模型；背调那一笔：放行", () => {
    expect(收拾请求体(体, cfg)).toMatchObject({ ok: true, body: { model: "deepseek-v4.1-flash" } });
    expect(收拾请求体(体, cfg, 背调模型表({} as NodeJS.ProcessEnv))).toMatchObject({ ok: true, body: { model: "claude-sonnet-5.5" } });
  });

  it("开始以后，背调用哪个模型听服务器的", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, 扣了: 6, 还剩: 20, 模型: "gpt-5.5" }), { status: 200 })));
    const 通道 = 云端通道({ baseUrl: "https://crm.example/api/gateway/v1", apiKey: "t", models: ["deepseek-v4.1-flash"] }, true);
    expect(通道.模型).toBeUndefined();
    await 通道.开始("run-2");
    expect(通道.模型).toBe("gpt-5.5");
  });
});
