import { closeTestDatabases } from "./close-databases";
/**
 * 背调的四个网关接口（api/gateway/v1/research/{start,search,read,finish}）。
 *
 * 和模型网关一样，钉的多是「什么时候不放行」：没令牌、次数不够、搜索超上限、没开始过的 runId、内网网址。
 * 正向的：start 扣 6、search 走模拟搜索、finish 没出报告整笔退；以及背调的编号在模型网关那边能跑满 60 步不被频率闸挡。
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
  await closeTestDatabases(临时根);
  fs.rmSync(临时根, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.GATEWAY_API_KEY = "upstream-key-research";
  process.env.GATEWAY_BASE_URL = 上游;
  process.env.GATEWAY_MODELS = "deepseek-chat";
  process.env.RESEARCH_SEARCH = "mock";
  const { resetAiQuota } = await import("@/lib/ai-quota");
  resetAiQuota();
  const { 清空背调记录 } = await import("@/lib/research/runs-memory");
  清空背调记录();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let 序号 = 0;
/** 建账号、签令牌、像登录过一样把注册赠送（30 次）结掉 */
async function 建账号带令牌() {
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
  it("扣 6，回还剩几次；重发不重扣", async () => {
    const { token, owner } = await 建账号带令牌();
    const { start } = await 路由();
    const res = await start(请求("research/start", token, { runId: "run-1", 走我们的模型: true }));
    expect(res.status).toBe(200);
    // 背调用哪个模型由服务器定（lib/gateway.ts 背调模型表），随回应带回去
    expect(await res.json()).toEqual({ ok: true, 扣了: 6, 还剩: 24, 模型: "claude-sonnet-5.5" });
    expect(res.headers.get("X-Credits-Remaining")).toBe("24");
    const 再来 = await start(请求("research/start", token, { runId: "run-1", 走我们的模型: true }));
    expect((await 再来.json()).扣了).toBe(0);
    expect(await 用掉(owner)).toBe(6);
  });

  it("自己的模型扣 2", async () => {
    const { token, owner } = await 建账号带令牌();
    await (await 路由()).start(请求("research/start", token, { runId: "run-own", 走我们的模型: false }));
    expect(await 用掉(owner)).toBe(2);
  });

  it("次数不够 → 402，一句中文，一次都不扣", async () => {
    const { token, owner } = await 建账号带令牌();
    const { control } = await import("@/lib/tenant/control");
    await control.accountAiUsage.upsert({ where: { accountId: owner.id }, create: { accountId: owner.id, calls: 27 }, update: { calls: 27 } });
    const res = await (await 路由()).start(请求("research/start", token, { runId: "run-poor", 走我们的模型: true }));
    expect(res.status).toBe(402);
    const msg = (await res.json()).error.message as string;
    expect(msg).toContain("一次背调要 6 次");
    expect(msg).toContain("只剩 3 次");
    expect(msg).toContain("自己的模型 API Key");
    expect(await 用掉(owner)).toBe(27);
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
    expect(await 用掉(owner)).toBe(6);
    const res = await finish(请求("research/finish", token, { runId: "run-fail", ok: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, 退了: 6, 还剩: 30 });
    expect(res.headers.get("X-Credits-Remaining")).toBe("30");
    expect(await (await finish(请求("research/finish", token, { runId: "run-fail", ok: false }))).json()).toEqual({ ok: true, 退了: 0, 还剩: 30 });
    expect((await search(请求("research/search", token, { runId: "run-fail", query: "Acme" }))).status).toBe(409);
  });

  it("出了报告不退", async () => {
    const { token, owner } = await 建账号带令牌();
    const { start, finish } = await 路由();
    await start(请求("research/start", token, { runId: "run-ok", 走我们的模型: true }));
    expect(await (await finish(请求("research/finish", token, { runId: "run-ok", ok: true, searches: 3, pages: 2 }))).json()).toEqual({ ok: true, 退了: 0, 还剩: 24 });
    expect(await 用掉(owner)).toBe(6);
  });

  it("ok 不是布尔 → 400；没开始过 → 404", async () => {
    const { token } = await 建账号带令牌();
    const { finish } = await 路由();
    expect((await finish(请求("research/finish", token, { runId: "x1", ok: "no" }))).status).toBe(400);
    expect((await finish(请求("research/finish", token, { runId: "x1", ok: false }))).status).toBe(404);
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
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { role: "assistant", content: "好的" }, finish_reason: "stop" }] })));
    for (let i = 0; i < 40; i++) {
      const res = await 问(请求("chat/completions", token, { model: "deepseek-chat", messages: [{ role: "user", content: `第 ${i} 步` }] }, { "X-Question-Id": "run-chat", "X-Feature": "research" }));
      expect(res.status, `第 ${i + 1} 步`).toBe(200);
    }
    expect(await 用掉(owner)).toBe(6);
  });
});
