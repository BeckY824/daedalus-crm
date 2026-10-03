/**
 * 第五轮对抗复查 · AI 网关（dfa6bc6：「只听最新那一份」、没带编号的按前两条消息合编号）
 *
 * 红的保持红，等修。
 *   一、合编号的「15 分钟」只在内存里：扣不扣看的是控制面库里的 aiCharge 行，那一行没有期限。
 *       0.46.2 及以前的桌面端里不带时间的功能（起草转介绍话术等），同一位客户第二天、第二周再点，一次都不扣，直到这一行攒满 20 次
 *   二、「两份都没人收到要退」只做在非流式那一支：agent 最后那一步是流式的（首字 20 秒、总共 120 秒），
 *       两份都卡住、桌面端已经报超时以后上游才回响应头，网关照样把流接出去，不退
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeTestDatabases } from "./close-databases";
import { 建控制库, 网关环境, 建账号带令牌, 用掉, 回文本, 云, 上游, 等一下 } from "./r2-ai-harness";

const 根 = path.join(os.tmpdir(), `r5-review-gw-${process.pid}`);
let 账号: Awaited<ReturnType<typeof 建账号带令牌>>;

beforeAll(() => 建控制库(根));
afterAll(async () => {
  await closeTestDatabases(根);
  fs.rmSync(根, { recursive: true, force: true });
  delete process.env.GATEWAY_API_KEY;
  delete process.env.GATEWAY_BASE_URL;
  delete process.env.GATEWAY_MODELS;
});
beforeEach(async () => {
  网关环境();
  (await import("@/lib/ai-quota")).resetAiQuota();
  (await import("@/lib/rate-limit")).重置限流();
  账号 = await 建账号带令牌();
});
afterEach(() => {
  delete process.env.MULTI_TENANT;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const 超时 = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

async function 打网关(body: Record<string, unknown>, opts: { qid?: string; signal?: AbortSignal } = {}): Promise<Response> {
  const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
  const headers: Record<string, string> = { Authorization: `Bearer ${账号.token}`, "Content-Type": "application/json" };
  if (opts.qid) headers["X-Question-Id"] = opts.qid;
  const req = new Request(`${云}/api/gateway/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "deepseek-v4.1-flash", ...body }),
    signal: opts.signal,
  });
  const 原 = process.env.MULTI_TENANT;
  process.env.MULTI_TENANT = "1";
  try {
    return await POST(req);
  } finally {
    if (原 === undefined) delete process.env.MULTI_TENANT;
    else process.env.MULTI_TENANT = 原;
  }
}

/* ---------------- 一、合编号没有期限 ---------------- */

describe("没带编号的老桌面端：同一段提示词隔天再发", () => {
  // 0.46.2 的「起草转介绍邀请」：系统提示 + 一段只含客户资料的提示词，里面没有日期——同一位客户每次都一模一样
  const 老客户端的话术请求 = {
    messages: [
      { role: "system", content: "你是一名销售助理。" },
      { role: "user", content: "你替销售「张三」起草一条发给已签约客户的微信消息……客户：王同学，已签约\n输出严格 JSON：{\"message\": \"...\"}" },
    ],
    response_format: { type: "json_object" },
  };

  it("15 分钟内连点两次算一个问题（提交说明里的口径，绿的，钉住）", async () => {
    vi.stubGlobal("fetch", async () => 回文本('{"message":"好"}'));
    expect((await 打网关(老客户端的话术请求)).status).toBe(200);
    expect((await 打网关(老客户端的话术请求)).status).toBe(200);
    expect(await 用掉(账号.acc.id)).toBe(1);
  });

  it("第二天同一位客户再起草一次：该再扣 1 次（现在不扣——aiCharge 那一行没有期限，攒满 20 次才重扣）", async () => {
    vi.stubGlobal("fetch", async () => 回文本('{"message":"好"}'));
    expect((await 打网关(老客户端的话术请求)).status).toBe(200);
    expect(await 用掉(账号.acc.id)).toBe(1);
    // 只假 Date：问过的 那张内存表按 Date.now 判 15 分钟，账本那一行不看时间
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 26 * 3600_000 });
    expect((await 打网关(老客户端的话术请求)).status).toBe(200);
    expect(await 用掉(账号.acc.id), "隔了一天的第二次起草").toBe(2);
  });
});

/* ---------------- 二、流式那一支没有「两份都没人收到就退」 ---------------- */

describe("agent 最后那一步（流式）：原请求和重发都卡住，桌面端已经报超时", () => {
  it("上游在桌面端放弃之后、网关超时之前回了响应头：用户什么都没拿到，不该扣（现在扣 1 次）", async () => {
    const 放行: (() => void)[] = [];
    let n = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(上游)) throw new TypeError(`没接这个地址：${url}`);
      n++;
      await new Promise<void>((r) => 放行.push(r));
      return new Response('data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const qid = `q-stream-both-slow-${Date.now()}`;
    const 流式 = { stream: true, messages: [{ role: "user", content: "王同学怎么样" }] };
    const c1 = new AbortController();
    const 原请求 = 打网关(流式, { qid, signal: c1.signal });
    while (n < 1) await 等一下(5);
    c1.abort(超时()); // 首字 20 秒没来：桌面端重发
    const c2 = new AbortController();
    const 重发 = 打网关(流式, { qid, signal: c2.signal });
    while (n < 2) await 等一下(5);
    c2.abort(超时()); // 总共 120 秒到点：桌面端报超时（网关这份是第 20 秒才进来的，它的上游超时到第 140 秒）
    放行.forEach((f) => f());
    const rs = await Promise.all([原请求, 重发]);
    await Promise.all(rs.map((r) => r.text().catch(() => "")));
    expect(await 用掉(账号.acc.id), "两份流都没人收").toBe(0);
  });

  it("对照：同样的剧本换成非流式，dfa6bc6 已经会退（绿的）", async () => {
    const 放行: (() => void)[] = [];
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      await new Promise<void>((r) => 放行.push(r));
      return 回文本("好");
    });
    const qid = `q-json-both-slow-${Date.now()}`;
    const 非流式 = { messages: [{ role: "user", content: "王同学怎么样" }] };
    const c1 = new AbortController();
    const 原请求 = 打网关(非流式, { qid, signal: c1.signal });
    while (n < 1) await 等一下(5);
    c1.abort(超时());
    const c2 = new AbortController();
    const 重发 = 打网关(非流式, { qid, signal: c2.signal });
    while (n < 2) await 等一下(5);
    c2.abort(超时());
    放行.forEach((f) => f());
    await Promise.all([原请求, 重发]);
    expect(await 用掉(账号.acc.id)).toBe(0);
  });
});
