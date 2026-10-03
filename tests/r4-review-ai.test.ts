/**
 * 第四轮对抗复查 · AI / 网关（aabd111 以及它没改到的邻居）
 *
 * 红的保持红，等修。
 *   一、网关去掉「桌面端走了就退」之后：原请求和重发都被桌面端放弃（两份都慢），上游后来都答完了——
 *       用户只看到「超时」，账上扣了 1 次
 *   二、客户端：5xx 重发的等待时间写成了 max(15s, 总超时 − 首轮)。长输出（粘成表格 8000 token）首轮 = 总超时，
 *       502 之后的那次重发只给 15 秒，必定超时；再叠上一，用户还被扣 1 次
 *   三、客户端：「坏 JSON 让模型修一次」那一步 `.catch(() => 降级再来)` 不看错误种类，5xx 时一次调用打到 5 次
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeTestDatabases } from "./close-databases";
import { resetDb } from "./reset";
import {
  建控制库, 网关环境, 建账号带令牌, 用掉, 装桌面端, 拆桌面端, 标准凭据, 接线,
  回文本, 回JSON, 云, 上游, 等一下,
} from "./r2-ai-harness";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));

const 根 = path.join(os.tmpdir(), `r4-review-ai-${process.pid}`);
let 目录 = "";
let 客户 = "";
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
  (await import("@/lib/llm")).重置模型探测();
  await resetDb();
  const { prisma } = await import("@/lib/prisma");
  await prisma.user.create({ data: { id: "tester-id", email: "t@t", name: "测试员", role: "ADMIN", password: "x" } });
  客户 = (await prisma.customer.create({ data: { name: "王同学", phone: "13800000001", salesOwnerId: "tester-id" } })).id;
  账号 = await 建账号带令牌();
  目录 = 装桌面端(标准凭据(账号.token));
});
afterEach(() => {
  // 两份网关请求并发时各自的 finally 会把 MULTI_TENANT 写回对方的值，这里兜底关掉
  delete process.env.MULTI_TENANT;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  拆桌面端(目录);
});

const 超时 = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

async function 打网关(qid: string, signal?: AbortSignal): Promise<Response> {
  const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
  const req = new Request(`${云}/api/gateway/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${账号.token}`, "Content-Type": "application/json", "X-Question-Id": qid },
    body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "王同学怎么样" }] }),
    signal,
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

/* ---------------- 一、网关：两份都被放弃 ---------------- */

describe("网关：原请求和重发都慢，桌面端两份都放弃了", () => {
  it("用户只看到「超时」，上游后来都答完了：这个问题不该扣（aabd111 前会退，现在扣 1 次）", async () => {
    const 放行: (() => void)[] = [];
    let n = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(上游)) throw new TypeError(`没接这个地址：${url}`);
      n++;
      // 中转站对两份都卡了 80 秒（桌面端：首轮 45 秒 + 重发 15 秒 = 60 秒就放弃；网关自己的上游超时是 120 秒）
      await new Promise<void>((r) => 放行.push(r));
      return 回文本('{"message":"好"}');
    });
    const qid = `q-both-slow-${Date.now()}`;
    const c1 = new AbortController();
    const 原请求 = 打网关(qid, c1.signal);
    while (n < 1) await 等一下(5);
    c1.abort(超时()); // 首轮 45 秒到点
    const c2 = new AbortController();
    const 重发 = 打网关(qid, c2.signal);
    while (n < 2) await 等一下(5);
    c2.abort(超时()); // 总超时 60 秒到点：桌面端报「AI 这次超时没回音」
    放行.forEach((f) => f());
    await Promise.all([原请求, 重发]);
    expect(await 用掉(账号.acc.id), "用户什么都没拿到").toBe(0);
  });
});

/* ---------------- 二、客户端：5xx 重发的等待时间 ---------------- */

describe("客户端：5xx 之后那次重发给多久", () => {
  it("粘成表格（8000 token、总超时 120 秒）：首次 502 秒回，重发只给 15 秒——长输出必定等不完", async () => {
    const 事件: string[] = [];
    const 原timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      事件.push(`t:${ms}`);
      return 原timeout(ms);
    });
    接线({
      上游: (r) => {
        事件.push(`up${r.第几次}`);
        if (r.第几次 === 1) return new Response("bad gateway", { status: 502 });
        return 回文本(JSON.stringify({ 表头: ["姓名", "手机号"], 数据: [["张三", "13800000002"]] }));
      },
    });
    const { 粘成表格 } = await import("@/app/(app)/customers/ai");
    await 粘成表格("张三 13800000002");
    const i = 事件.indexOf("up1");
    expect(i, 事件.join(" ")).toBeGreaterThanOrEqual(0);
    // up1（502）之后桌面端建的第一个超时信号就是重发那次的
    const 重发给 = Number(事件.slice(i + 1).find((e) => e.startsWith("t:"))?.slice(2));
    // 首次 502 是秒回的，总预算 120 秒几乎没动；重发至少该给原来首轮那么长（这里放宽到 60 秒）
    expect(重发给, 事件.join(" ")).toBeGreaterThanOrEqual(60_000);
  });
});

/* ---------------- 三、客户端：修 JSON 那一步 ---------------- */

describe("客户端：模型先回了坏 JSON、之后上游一直 502", () => {
  it("chatJSON（起草话术）：修 JSON 那一步 502 → 重发 502 → `.catch` 降级 → 又 502、502，一共打了 5 次", async () => {
    const 线 = 接线({
      上游: (r) => (r.第几次 === 1 ? 回文本("这不是 JSON") : new Response("bad gateway", { status: 502 })),
    });
    const r = await (await import("@/app/(app)/dashboard/ai")).draftWakeup({ customerId: 客户, reason: "沉睡 20 天" });
    expect(r.ok).toBe(false);
    // aabd111 说「一次调用最多打两次」，只改了第一道 catch；修 JSON 那一道的 .catch(() => …) 什么错都吞
    // 期望：第一次（坏 JSON）+ 修 JSON 一次 + 5xx 重发一次 = 3
    expect(线.上游.length).toBeLessThanOrEqual(3);
  });
});

void 回JSON;
