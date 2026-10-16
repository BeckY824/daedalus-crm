import { closeTestDatabases } from "./close-databases";
/**
 * 背调的四个网关接口（api/gateway/v1/research/{start,search,read,finish}）。
 *
 * 和模型网关一样，钉的多是「什么时候不放行」：没令牌、次数不够、搜索超上限、没开始过的 runId、内网网址。
 * 正向的：start 扣 1 次背调次数（和问答的 AI 次数分开；自己填了 Key 的也照扣）、search 走模拟搜索、finish 没出报告整笔退、
 * 花费到上限（RESEARCH_COST_CAP）不再给搜；以及背调的编号在模型网关那边能跑满 60 步不被频率闸挡、不扣 AI 次数、花费累到这次背调上。
 * 不连网：搜索用 RESEARCH_SEARCH=mock 或假 fetch，读页只测会被拦下的地址。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-research-gw-${process.pid}`);
const 上游 = "https://relay.example.com/v1";

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  process.env.MULTI_TENANT = "1";
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时根, "control.db")}`;
  const sql = execFileSync(
    process.execPath,
    [path.resolve("node_modules/prisma/build/index.js"), "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const ddl = path.join(临时根, "control.sql");
  fs.writeFileSync(ddl, sql);
  execFileSync("node", ["--experimental-sqlite", "-e", `
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const db = new DatabaseSync(process.argv[1]);
    db.exec(fs.readFileSync(process.argv[2], 'utf8'));
    db.close();
  `, path.join(临时根, "control.db"), ddl], { stdio: "pipe" });
});

afterAll(async () => {
  delete process.env.MULTI_TENANT;
  delete process.env.GATEWAY_API_KEY;
  delete process.env.GATEWAY_BASE_URL;
  delete process.env.GATEWAY_MODELS;
  delete process.env.RESEARCH_SEARCH;
  delete process.env.AI_PRICE_TABLE;
  delete process.env.RESEARCH_COST_CAP;
  await closeTestDatabases(临时根);
  fs.rmSync(临时根, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.GATEWAY_API_KEY = "upstream-key-research";
  process.env.GATEWAY_BASE_URL = 上游;
  process.env.GATEWAY_MODELS = "deepseek-chat";
  process.env.RESEARCH_SEARCH = "mock";
  delete process.env.AI_PRICE_TABLE;
  delete process.env.RESEARCH_COST_CAP;
  const { resetAiQuota } = await import("@/lib/ai-quota");
  resetAiQuota();
  const { 清空背调记录 } = await import("@/lib/research/runs-memory");
  清空背调记录();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let 序号 = 0;
/** 建账号、签令牌、像登录过一样把注册赠送（30 次 AI）结掉，再送 背调次（默认 3 次背调，和 AI 次数分开记） */
async function 建账号带令牌(背调次 = 3) {
  const { createAccount } = await import("@/lib/tenant/accounts");
  const { 签发 } = await import("@/lib/tenant/device-token");
  const { 结算赠送 } = await import("@/lib/tenant/credits");
  const 第几个 = 序号++;
  const acc = await createAccount({
    target: { kind: "phone", value: `1390000${String(第几个).padStart(4, "0")}` },
    password: "abcd1234",
    name: "背调用户",
  });
  const { token } = await 签发(acc.id, "我的 MacBook");
  await 结算赠送({ kind: "account", id: acc.id }, createHash("sha256").update(`背调测试机器:${第几个}`).digest("hex"));
  if (背调次 > 0) await (await import("@/lib/tenant/credits")).赠送背调(acc.id, { amount: 背调次, reason: "admin" });
  return { acc, token, owner: { kind: "account" as const, id: acc.id } };
}

function 请求(路径: string, token: string | null, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://app.example.com/api/gateway/v1/${路径}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const 路由 = async () => ({
  start: (await import("@/app/api/gateway/v1/research/start/route")).POST,
  search: (await import("@/app/api/gateway/v1/research/search/route")).POST,
  read: (await import("@/app/api/gateway/v1/research/read/route")).POST,
  finish: (await import("@/app/api/gateway/v1/research/finish/route")).POST,
});
const 用掉 = async (owner: { kind: "account"; id: string }) => (await import("@/lib/tenant/credits")).用掉次数(owner);
const 背调剩 = async (owner: { kind: "account"; id: string }) => (await (await import("@/lib/tenant/credits")).背调余额(owner)).还剩;

describe("门口", () => {
  it("没令牌 → 401；四个接口都一样", async () => {
    const r = await 路由();
    for (const [名, POST] of Object.entries(r)) {
      expect((await POST(请求(`research/${名}`, null, { runId: "r1" }))).status, 名).toBe(401);
    }
  });

  it("没配网关 → 404", async () => {
    delete process.env.GATEWAY_API_KEY;
    const { token } = await 建账号带令牌();
    expect((await (await 路由()).start(请求("research/start", token, { runId: "r1", 走我们的模型: true }))).status).toBe(404);
  });

  it("runId 不对 → 400；请求体太大 → 413", async () => {
    const { token } = await 建账号带令牌();
    const { start } = await 路由();
    expect((await start(请求("research/start", token, { runId: "有空格 的", 走我们的模型: true }))).status).toBe(400);
    expect((await start(请求("research/start", token, { runId: "r1", pad: "x".repeat(20_000) }))).status).toBe(413);
  });
});

describe("start", () => {
  it("扣 1 次背调，回还剩几次和这次用哪些模型；重发不重扣；问答次数不动", async () => {
    const { token, owner } = await 建账号带令牌(3);
    const { start } = await 路由();
    const res = await start(请求("research/start", token, { runId: "run-1" }));
    expect(res.status).toBe(200);
    // 模型由服务器定：最后打分写报告固定 gpt-5.5；摘要默认同报告；搜索上限默认 8（lib/research/price.ts）
    expect(await res.json()).toEqual({ ok: true, 扣了: 1, 还剩: 2, 模型: "gpt-5.5", 摘要模型: "gpt-5.5", 搜索上限: 8 });
    const 再来 = await start(请求("research/start", token, { runId: "run-1" }));
    expect((await 再来.json()).扣了).toBe(0);
    expect(await 背调剩(owner)).toBe(2);
    expect(await 用掉(owner)).toBe(0);
  });

  it("降本开关从配置来：摘要模型、搜索上限", async () => {
    const { token } = await 建账号带令牌();
    process.env.RESEARCH_SUMMARY_MODEL = "gpt-5.4-mini";
    process.env.RESEARCH_SEARCH_LIMIT = "5";
    try {
      const body = await (await (await 路由()).start(请求("research/start", token, { runId: "run-cfg" }))).json();
      expect(body).toMatchObject({ 模型: "gpt-5.5", 摘要模型: "gpt-5.4-mini", 搜索上限: 5 });
    } finally {
      delete process.env.RESEARCH_SUMMARY_MODEL;
      delete process.env.RESEARCH_SEARCH_LIMIT;
    }
  });

  it("自己填了模型 Key 的（老客户端带 走我们的模型: false）也照扣：背调的搜索和分析都用我们的", async () => {
    const { token, owner } = await 建账号带令牌(3);
    await (await 路由()).start(请求("research/start", token, { runId: "run-own", 走我们的模型: false }));
    expect(await 背调剩(owner)).toBe(2);
  });

  it("背调次数用完 → 402，一句中文，一次都不扣（问答次数再多也不顶用）", async () => {
    const { token, owner } = await 建账号带令牌(0);
    const res = await (await 路由()).start(请求("research/start", token, { runId: "run-poor" }));
    expect(res.status).toBe(402);
    const msg = (await res.json()).error.message as string;
    expect(msg).toContain("背调次数用完了");
    expect(msg).toContain("你还剩 0 次背调");
    expect(msg).not.toContain("API Key");
    expect(await 用掉(owner)).toBe(0);
  });
});

describe("search", () => {
  it("没开始过的 runId → 404，不搜", async () => {
    const { token } = await 建账号带令牌();
    expect((await (await 路由()).search(请求("research/search", token, { runId: "never", query: "Acme" }))).status).toBe(404);
  });

  it("走模拟搜索回结果；空查询 400", async () => {
    const { token } = await 建账号带令牌();
    const { start, search } = await 路由();
    await start(请求("research/start", token, { runId: "run-s", 走我们的模型: true }));
    const res = await search(请求("research/search", token, { runId: "run-s", query: "  Acme Lighting  " }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.length).toBeGreaterThanOrEqual(3);
    expect(body.results[0].title).toContain("Acme Lighting");
    expect((await search(请求("research/search", token, { runId: "run-s", query: "   " }))).status).toBe(400);
  });

  it("搜到 背调上限.搜索 + 2 次之后 → 429", async () => {
    const { token } = await 建账号带令牌();
    const { start, search } = await 路由();
    const { 背调上限 } = await import("@/lib/research/types");
    await start(请求("research/start", token, { runId: "run-cap", 走我们的模型: true }));
    for (let i = 0; i < 背调上限.搜索 + 2; i++) {
      expect((await search(请求("research/search", token, { runId: "run-cap", query: `q${i}` }))).status).toBe(200);
    }
    const 超 = await search(请求("research/search", token, { runId: "run-cap", query: "one more" }));
    expect(超.status).toBe(429);
    expect((await 超.json()).error.message).toBe("这次背调的搜索次数到上限了");
  });

  it("搜索服务挂了 → 502，名额还回去；报错和日志里都没有 Key；用量照记", async () => {
    process.env.RESEARCH_SEARCH = "gpt";
    const { token, owner } = await 建账号带令牌();
    const { start, search } = await 路由();
    await start(请求("research/start", token, { runId: "run-err", 走我们的模型: true }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`bad key upstream-key-research`, { status: 500 })));
    const 日志 = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await search(请求("research/search", token, { runId: "run-err", query: "Acme" }));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("upstream-key-research");
    expect(JSON.stringify(日志.mock.calls)).not.toContain("upstream-key-research");
    const { control } = await import("@/lib/tenant/control");
    expect((await control.aiResearchRun.findFirst({ where: { ownerId: owner.id, runId: "run-err" } }))?.searches).toBe(0);

    // 好了以后：成本账按 research 记一行
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      model: "gpt-5.5",
      output: [{ type: "message", content: [{ type: "output_text", text: "x | [a](https://a.example/) | y", annotations: [{ type: "url_citation", url: "https://a.example/", title: "A", start_index: 4, end_index: 27 }] }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })));
    expect((await search(请求("research/search", token, { runId: "run-err", query: "Acme" }))).status).toBe(200);
    const call = await control.aiCall.findFirst({ where: { ownerId: owner.id } });
    expect(call).toMatchObject({ feature: "research", model: "gpt-5.5", inputTokens: 10, outputTokens: 5 });
  });

  it("别人的 runId 搜不了", async () => {
    const a = await 建账号带令牌();
    const b = await 建账号带令牌();
    const { start, search } = await 路由();
    await start(请求("research/start", a.token, { runId: "run-mine", 走我们的模型: true }));
    expect((await search(请求("research/search", b.token, { runId: "run-mine", query: "Acme" }))).status).toBe(404);
  });
});

describe("read", () => {
  it("内网网址 → 422，一句中文；名额照占（见 read/route.ts 的注释）", async () => {
    const { token, owner } = await 建账号带令牌();
    const { start, read } = await 路由();
    await start(请求("research/start", token, { runId: "run-r", 走我们的模型: true }));
    const res = await read(请求("research/read", token, { runId: "run-r", url: "http://169.254.169.254/latest/meta-data/" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toBe("这个网址读不了：不能读内网地址");
    const { control } = await import("@/lib/tenant/control");
    expect((await control.aiResearchRun.findFirst({ where: { ownerId: owner.id, runId: "run-r" } }))?.pages).toBe(1);
  });

  it("读满上限之后 → 429", async () => {
    const { token } = await 建账号带令牌();
    const { start, read } = await 路由();
    const { 背调上限 } = await import("@/lib/research/types");
    await start(请求("research/start", token, { runId: "run-rc", 走我们的模型: true }));
    for (let i = 0; i < 背调上限.读页 + 2; i++) await read(请求("research/read", token, { runId: "run-rc", url: "http://127.0.0.1/" }));
    expect((await read(请求("research/read", token, { runId: "run-rc", url: "http://127.0.0.1/" }))).status).toBe(429);
  });
});

describe("finish", () => {
  it("没出报告整笔退；再收一次不重复退；之后搜不了", async () => {
    const { token, owner } = await 建账号带令牌();
    const { start, search, finish } = await 路由();
    await start(请求("research/start", token, { runId: "run-fail", 走我们的模型: true }));
    expect(await 背调剩(owner)).toBe(2);
    const res = await finish(请求("research/finish", token, { runId: "run-fail", ok: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, 退了: 1, 还剩: 3 });
    expect(await (await finish(请求("research/finish", token, { runId: "run-fail", ok: false }))).json()).toEqual({ ok: true, 退了: 0, 还剩: 3 });
    expect((await search(请求("research/search", token, { runId: "run-fail", query: "Acme" }))).status).toBe(409);
  });

  it("出了报告不退", async () => {
    const { token, owner } = await 建账号带令牌();
    const { start, finish } = await 路由();
    await start(请求("research/start", token, { runId: "run-ok", 走我们的模型: true }));
    expect(await (await finish(请求("research/finish", token, { runId: "run-ok", ok: true, searches: 3, pages: 2 }))).json()).toEqual({ ok: true, 退了: 0, 还剩: 2 });
    expect(await 背调剩(owner)).toBe(2);
  });

  it("ok 不是布尔 → 400；没开始过 → 404", async () => {
    const { token } = await 建账号带令牌();
    const { finish } = await 路由();
    expect((await finish(请求("research/finish", token, { runId: "x1", ok: "no" }))).status).toBe(400);
    expect((await finish(请求("research/finish", token, { runId: "x1", ok: false }))).status).toBe(404);
  });
});

describe("退不退由服务器判断（10-16 下午总控定：别让用户为我们的超时买单）", () => {
  const 问一步 = async (token: string, runId: string, stage: string) => {
    const { POST: 问 } = await import("@/app/api/gateway/v1/chat/completions/route");
    return 问(请求("chat/completions", token, { model: "gpt-5.5", messages: [{ role: "user", content: stage }] }, { "X-Question-Id": runId, "X-Feature": "research", "X-Research-Stage": stage }));
  };
  const 好回答 = () => vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })));
  const 这一行 = async (ownerId: string, runId: string) => (await import("@/lib/tenant/control")).control.aiResearchRun.findFirst({ where: { ownerId, runId } });

  it("上游超时：网关记一笔我们这边的失败、回 504；拿到了材料、没跑完 → 退这 1 次", async () => {
    const { token, owner } = await 建账号带令牌();
    const { start, search, finish } = await 路由();
    await start(请求("research/start", token, { runId: "run-slow", 走我们的模型: true }));
    expect((await search(请求("research/search", token, { runId: "run-slow", query: "Acme" }))).status).toBe(200);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }))));
    expect((await 问一步(token, "run-slow", "basics")).status).toBe(504);
    expect((await 这一行(owner.id, "run-slow"))?.failures).toBe(1);
    expect(await (await finish(请求("research/finish", token, { runId: "run-slow", ok: false }))).json()).toEqual({ ok: true, 退了: 1, 还剩: 3 });
  });

  it("上游 5xx 也记；用户自己停的（取消）照样不退", async () => {
    const { token, owner } = await 建账号带令牌();
    const { start, search, finish } = await 路由();
    await start(请求("research/start", token, { runId: "run-stop", 走我们的模型: true }));
    await search(请求("research/search", token, { runId: "run-stop", query: "Acme" }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
    expect((await 问一步(token, "run-stop", "fit")).status).toBe(502);
    expect((await 这一行(owner.id, "run-stop"))?.failures).toBe(1);
    expect(await (await finish(请求("research/finish", token, { runId: "run-stop", ok: false, 取消: true }))).json()).toEqual({ ok: true, 退了: 0, 还剩: 2 });
  });

  it("最后一步（X-Research-Stage: approach）交出去了 = 跑完了：中间超时过也不退", async () => {
    const { token, owner } = await 建账号带令牌();
    const { start, search, finish } = await 路由();
    await start(请求("research/start", token, { runId: "run-done", 走我们的模型: true }));
    await search(请求("research/search", token, { runId: "run-done", query: "Acme" }));
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }))));
    await 问一步(token, "run-done", "basics");
    好回答();
    await 问一步(token, "run-done", "basics");
    expect((await 这一行(owner.id, "run-done"))?.reportAt).toBeNull();
    await 问一步(token, "run-done", "approach");
    expect((await 这一行(owner.id, "run-done"))?.reportAt).toBeInstanceOf(Date);
    // 桌面端就算报「没跑完」也不退：最后一步服务器亲手交出去了
    expect(await (await finish(请求("research/finish", token, { runId: "run-done", ok: false }))).json()).toEqual({ ok: true, 退了: 0, 还剩: 2 });
  });

  it("没见到我们这边出错、桌面端却说没跑完（跳过最后一步白拿材料）：不退", async () => {
    const { token } = await 建账号带令牌();
    const { start, search, finish } = await 路由();
    await start(请求("research/start", token, { runId: "run-skip", 走我们的模型: true }));
    await search(请求("research/search", token, { runId: "run-skip", query: "Acme" }));
    好回答();
    await 问一步(token, "run-skip", "basics");
    expect(await (await finish(请求("research/finish", token, { runId: "run-skip", ok: false }))).json()).toEqual({ ok: true, 退了: 0, 还剩: 2 });
  });

  it("搜索两趟都没搜成：也算我们这边的失败", async () => {
    process.env.RESEARCH_SEARCH = "gpt";
    const { token, owner } = await 建账号带令牌();
    const { start, search } = await 路由();
    await start(请求("research/start", token, { runId: "run-nosearch", 走我们的模型: true }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 500 })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await search(请求("research/search", token, { runId: "run-nosearch", query: "Acme" }))).status).toBe(502);
    expect((await 这一行(owner.id, "run-nosearch"))?.failures).toBe(1);
  });

  it("取消 不是布尔 → 400", async () => {
    const { token } = await 建账号带令牌();
    const { start, finish } = await 路由();
    await start(请求("research/start", token, { runId: "run-x", 走我们的模型: true }));
    expect((await finish(请求("research/finish", token, { runId: "run-x", ok: false, 取消: "yes" }))).status).toBe(400);
  });
});

describe("模型网关认得背调的编号", () => {
  it("同一个 runId 跑 40 步：一次都不另扣，频率闸也不挡（普通问题第 21 步起要过闸）", async () => {
    const { token, acc, owner } = await 建账号带令牌();
    const { start } = await 路由();
    const { POST: 问 } = await import("@/app/api/gateway/v1/chat/completions/route");
    const { consumeAiQuota, AI_LIMIT } = await import("@/lib/ai-quota");
    await start(请求("research/start", token, { runId: "run-chat", 走我们的模型: true }));
    // 频率闸只剩 1 次：第一步用掉它，后面 39 步全靠背调的放宽
    for (let i = 0; i < AI_LIMIT - 1; i++) consumeAiQuota(`gw:${acc.id}`);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { role: "assistant", content: "好的" }, finish_reason: "stop" }], usage: { prompt_tokens: 10_000, completion_tokens: 1_000, prompt_tokens_details: { cached_tokens: 4_000 } } })));
    for (let i = 0; i < 40; i++) {
      const res = await 问(请求("chat/completions", token, { model: "gpt-5.5", messages: [{ role: "user", content: `第 ${i} 步` }] }, { "X-Question-Id": "run-chat", "X-Feature": "research" }));
      expect(res.status, `第 ${i + 1} 步`).toBe(200);
    }
    // 背调里的模型调用一次 AI 次数都不扣（钱在背调次数里收了）
    expect(await 用掉(owner)).toBe(0);
    // 每步的模型钱累到这次背调上：gpt-5.5 按 b.ai 实价 1 万入（其中 4 千命中缓存）+ 1 千出 = (6000×5 + 4000×0.5 + 1000×30)/1e6 = $0.062 ≈ 0.446 元（按厘记），40 步 ≈ 17.84 元
    const { 背调已花 } = await import("@/lib/tenant/credits");
    expect(await 背调已花(owner, "run-chat")).toBeCloseTo(17.84, 1);
  });
});

describe("问价 / 单次成本上限", () => {
  it("问价：扣几次、还剩几次；没令牌 401", async () => {
    const { token } = await 建账号带令牌();
    const { GET } = await import("@/app/api/gateway/v1/research/price/route");
    const res = await GET(new Request("https://app.example.com/api/gateway/v1/research/price", { headers: { Authorization: `Bearer ${token}` } }));
    expect(await res.json()).toEqual({ 扣次: 1, 还剩: 3 });
    expect((await GET(new Request("https://app.example.com/api/gateway/v1/research/price"))).status).toBe(401);
  });

  it("花到上限（RESEARCH_COST_CAP）就不再给搜、不再给读；回应里一直带着花了多少", async () => {
    const { token } = await 建账号带令牌();
    process.env.RESEARCH_COST_CAP = "0.1";
    const { start, search, read } = await 路由();
    await start(请求("research/start", token, { runId: "run-money" }));
    // 模拟搜索没有 token，只收每次的搜索费：$0.01 × 7.2 = 0.072 元
    const 第一次 = await (await search(请求("research/search", token, { runId: "run-money", query: "Acme" }))).json();
    expect(第一次.花费).toEqual({ 已花元: 0.072, 上限元: 0.1 });
    await search(请求("research/search", token, { runId: "run-money", query: "Acme 2" }));
    const 到了 = await search(请求("research/search", token, { runId: "run-money", query: "Acme 3" }));
    expect(到了.status).toBe(429);
    expect((await 到了.json()).error.message).toContain("花费到上限");
    expect((await read(请求("research/read", token, { runId: "run-money", url: "https://example.com/" }))).status).toBe(429);
  });
});
