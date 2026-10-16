/**
 * 背调的搜索服务（lib/research/providers.ts）。不连网：上游一律用假 fetch。
 *
 * 钉三件事：
 *   1. 两家的回应（10-16 在真中转站上抓的形状）解析成 搜索结果[]：标题、网址、摘要、时间，去重、最多 8 条
 *   2. Claude 挂了换 GPT 试一次；换了还挂就抛，报错里没有 Key
 *   3. 请求发对了地方、带对了头（Claude 走 {根}/v1/messages，GPT 走 {baseUrl}/responses）
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { 解析Claude回应, 解析GPT回应, claude搜索, gpt搜索, 模拟搜索, 选搜索服务, 每次最多条 } from "@/lib/research/providers";

const cfg = { baseUrl: "https://relay.example.com/v1", apiKey: "fake-relay-key", models: [{ id: "deepseek-chat" }] };

const Claude回应 = {
  id: "msg_1",
  model: "claude-sonnet-5.5",
  content: [
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "Acme Lighting 进口商" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: [
        { type: "web_search_result", url: "https://acme.example/about", title: "About Acme Lighting", page_age: "2026-09-01", encrypted_content: "xx" },
        { type: "web_search_result", url: "https://news.example/acme-expands", title: "Acme expands to Poland", page_age: null, encrypted_content: "yy" },
        { type: "web_search_result", url: "https://acme.example/about#team", title: "About Acme (dup)", encrypted_content: "zz" },
        { type: "web_search_result", url: "https://dir.example/acme", title: "Acme in directory", encrypted_content: "ww" },
      ],
    },
    {
      type: "text",
      text: "About Acme Lighting | https://acme.example/about | 一家做 LED 的进口商\n",
      citations: [{ type: "web_search_result_location", url: "https://acme.example/about", title: "About Acme Lighting", cited_text: "Acme Lighting imports LED fixtures since 2009." }],
    },
    { type: "text", text: "Acme in directory | https://dir.example/acme | 行业名录里的条目，**员工 50 人**\n" },
  ],
  usage: { input_tokens: 1234, output_tokens: 210 },
};

const GPT回应 = {
  id: "resp_1",
  model: "gpt-5.5",
  output: [
    { type: "web_search_call", id: "ws_1", status: "completed" },
    {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "Acme 官网 | ([acme.example](https://acme.example/?utm_source=openai)) | 介绍公司历史和产品线\nAcme 招聘 | ([jobs.example](https://jobs.example/acme?utm_source=openai)) | 正在招采购经理",
          annotations: [
            { type: "url_citation", url: "https://acme.example/?utm_source=openai", title: "Acme 官网", start_index: 11, end_index: 59 },
            { type: "url_citation", url: "https://jobs.example/acme?utm_source=openai", title: "Acme 招聘", start_index: 85, end_index: 140 },
            { type: "url_citation", url: "https://acme.example/?utm_source=openai", title: "重复的", start_index: 11, end_index: 59 },
          ],
        },
      ],
    },
  ],
  usage: { input_tokens: 900, output_tokens: 150 },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("解析 Claude messages 回应", () => {
  it("结果来自 web_search_tool_result，摘要优先用引用原文，其次模型那一行；同一网址只留一条", () => {
    const r = 解析Claude回应(Claude回应);
    expect(r.map((x) => x.url)).toEqual(["https://acme.example/about", "https://news.example/acme-expands", "https://dir.example/acme"]);
    expect(r[0]).toEqual({ title: "About Acme Lighting", url: "https://acme.example/about", snippet: "Acme Lighting imports LED fixtures since 2009.", published: "2026-09-01" });
    expect(r[1].published).toBeUndefined();
    expect(r[1].snippet).toBe("");
    expect(r[2].snippet).toBe("行业名录里的条目， 员工 50 人");
  });

  it("最多 8 条", () => {
    const 多 = {
      content: [{ type: "web_search_tool_result", content: Array.from({ length: 20 }, (_, i) => ({ type: "web_search_result", url: `https://s${i}.example/`, title: `t${i}` })) }],
    };
    expect(解析Claude回应(多)).toHaveLength(每次最多条);
  });

  it("搜索工具报错（content 不是数组）不炸，回空", () => {
    expect(解析Claude回应({ content: [{ type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } }] })).toEqual([]);
    expect(解析Claude回应(null)).toEqual([]);
  });
});

describe("解析 GPT responses 回应", () => {
  it("结果来自 url_citation，去掉 utm_source=openai，摘要取引用所在那一行", () => {
    const r = 解析GPT回应(GPT回应);
    expect(r).toEqual([
      { title: "Acme 官网", url: "https://acme.example/", snippet: "介绍公司历史和产品线" },
      { title: "Acme 招聘", url: "https://jobs.example/acme", snippet: "正在招采购经理" },
    ]);
  });
});

describe("发请求", () => {
  it("Claude：{根}/v1/messages，带 x-api-key 和 anthropic-version，max_uses 1；带回用量", async () => {
    const f = vi.fn(async () => json(Claude回应));
    vi.stubGlobal("fetch", f);
    const r = await claude搜索(cfg).search("Acme Lighting 进口商", {});
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://relay.example.com/v1/messages");
    const h = init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe(cfg.apiKey);
    expect(h["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("claude-sonnet-5.5");
    expect(body.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 1 }]);
    expect(body.messages[0].content).toContain("Acme Lighting 进口商");
    expect(r.usage).toEqual({ model: "claude-sonnet-5.5", input: 1234, output: 210 });
    expect(r.results).toHaveLength(3);
  });

  it("GPT：{baseUrl}/responses，工具 web_search", async () => {
    const f = vi.fn(async () => json(GPT回应));
    vi.stubGlobal("fetch", f);
    const r = await gpt搜索(cfg).search("Acme", {});
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://relay.example.com/v1/responses");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "gpt-5.5", tools: [{ type: "web_search" }] });
    expect(r.usage).toEqual({ model: "gpt-5.5", input: 900, output: 150 });
    expect(r.results).toHaveLength(2);
  });
});

describe("挑服务和兜底", () => {
  it("默认 Claude；它 5xx 了换 GPT 试一次", async () => {
    const f = vi.fn(async (url: string) => (url.endsWith("/messages") ? new Response("bad gateway", { status: 502 }) : json(GPT回应)));
    vi.stubGlobal("fetch", f);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = 选搜索服务(cfg, {});
    expect(s.名).toBe("claude");
    const r = await s.search("Acme", {});
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.results[0].url).toBe("https://acme.example/");
    expect(r.usage?.model).toBe("gpt-5.5");
  });

  it("超时 / 连不上也换", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.endsWith("/messages")) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      return json(GPT回应);
    });
    vi.stubGlobal("fetch", f);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await 选搜索服务(cfg, {}).search("Acme", {})).results).toHaveLength(2);
  });

  it("两家都挂了就抛，报错里没有 Key（中转站把 Key 回显在错误体里也一样）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`invalid key ${cfg.apiKey}`, { status: 401 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = await 选搜索服务(cfg, {}).search("Acme", {}).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).not.toContain(cfg.apiKey);
    expect((e as Error).message).toContain("****");
  });

  it("RESEARCH_SEARCH=gpt 只走 GPT，不兜底；RESEARCH_SEARCH_MODEL 换模型", async () => {
    const f = vi.fn(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", f);
    const s = 选搜索服务(cfg, { RESEARCH_SEARCH: "gpt", RESEARCH_SEARCH_MODEL: "gpt-6" });
    await expect(s.search("Acme", {})).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)).model).toBe("gpt-6");
  });

  it("RESEARCH_SEARCH=mock：不连网，同一句查询结果一样，域名全是 .example", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const s = 选搜索服务(cfg, { RESEARCH_SEARCH: "mock" });
    const a = await s.search("Acme", {});
    const b = await 模拟搜索().search("Acme", {});
    expect(a).toEqual(b);
    expect(a.results.length).toBeGreaterThanOrEqual(3);
    for (const r of a.results) expect(new URL(r.url).hostname.endsWith(".example")).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });
});
