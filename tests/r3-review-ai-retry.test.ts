/**
 * 第三轮对抗复查 · AI 快速重发 / 网关按问题扣次数（b005246、a869c53、259f7b9、c680bf4）
 *
 * 只钉「修法本身」引出来的问题。红的保持红，等修。
 *   一、客户端：同一问题的请求总数封顶 2 次——超时重发和 5xx 重发叠起来、chatMessagesJSON 的降级叠起来
 *   二、网关：「桌面端走了就退」+「同一编号不再扣」叠起来，慢的原请求回来时把整个问题退成 0 次
 *   三、网关：频率闸按问题算之后，同一个编号可以无限发
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeTestDatabases } from "./close-databases";
import { resetDb } from "./reset";
import {
  建控制库, 网关环境, 建账号带令牌, 用掉, 装桌面端, 拆桌面端, 标准凭据, 接线,
  回文本, 回JSON, 问AI, 种类, 云, 上游, 等一下,
} from "./r2-ai-harness";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));

const 根 = path.join(os.tmpdir(), `r3-review-ai-${process.pid}`);
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
  vi.unstubAllGlobals();
  拆桌面端(目录);
});

const 超时 = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

/* ---------------- 一、客户端封顶 2 次 ---------------- */

describe("客户端：上游持续出错时，同一个问题的请求总数封顶 2 次", () => {
  it("chatJSON（起草话术）：首轮超时重发 → 重发那次 502 → 又按 5xx 再重发一次，一共 3 次", async () => {
    let 云端请求 = 0;
    const 线 = 接线({
      上游: () => new Response("bad gateway", { status: 502 }),
      云端回: (url) => {
        if (!url.includes("/chat/completions")) return null;
        云端请求++;
        // 第一次：桌面端这边首轮等待到点（代替真等 45 秒）；之后照常打到网关，上游一直 502
        if (云端请求 === 1) throw 超时();
        return null;
      },
    });
    const r = await (await import("@/app/(app)/dashboard/ai")).draftWakeup({ customerId: 客户, reason: "沉睡 20 天" });
    expect(r.ok).toBe(false);
    // chatRaw 里两道重发各自只管「一次」，叠起来是 3 次：超时那次 + 超时重发 + 502 重发
    expect(云端请求, `打到云端 ${云端请求} 次（其中上游 ${线.上游.length} 次）`).toBeLessThanOrEqual(2);
  });

  it("agent 退回 JSON 协议那条路（中转站不认 tools）：决策步上游一直 502，chatMessagesJSON 降级再来一轮，一步打了 4 次", async () => {
    const 线 = 接线({
      上游: (r) => {
        const k = 种类(r);
        // 中转站不认 tools：400 → agent 退回 JSON 协议（这是 a869c53 照旧放行的那一类）
        if (k === "决策") return 回JSON({ error: { message: "tools is not supported" } }, 400);
        return new Response("bad gateway", { status: 502 });
      },
    });
    const { result } = await 问AI("王同学现在怎么样了");
    expect(result?.ok).toBe(false);
    const JSON那几次 = 线.上游.filter((r) => 种类(r) === "JSON").length;
    // chatRaw：502 → 重发 502；抛到 chatMessagesJSON → 「降级重试」（它没学 chatJSON 那句「>=500 不再降级」）→ chatRaw 又 502 → 重发 502
    expect(JSON那几次, `JSON 协议那一步打了上游 ${JSON那几次} 次`).toBeLessThanOrEqual(2);
  });
});

/* ---------------- 二、网关：慢的原请求 + 重发 ---------------- */

/** 直接打网关路由。`signal` 模拟桌面端那边的连接（它超时 / 人点停时断开） */
async function 打网关(qid: string | null, signal?: AbortSignal): Promise<Response> {
  const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
  const headers: Record<string, string> = { Authorization: `Bearer ${账号.token}`, "Content-Type": "application/json" };
  if (qid) headers["X-Question-Id"] = qid;
  const req = new Request(`${云}/api/gateway/v1/chat/completions`, {
    method: "POST",
    headers,
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

/** 上游：第 n 次调用怎么回由剧本决定；可以挂起直到放行 */
function 假上游(剧本: (第几次: number) => Promise<Response> | Response) {
  let n = 0;
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(上游)) throw new TypeError(`没接这个地址：${url}`);
    return 剧本(++n);
  });
  return { 次数: () => n };
}

describe("网关：快速重发时原请求其实没死（只是慢）", () => {
  it("原请求（扣了）被桌面端放弃 → 重发（同编号，不扣）答出来 → 原请求晚些回来触发「桌面端走了就退」→ 这个问题净扣 0 次", async () => {
    let 放行!: () => void;
    const 卡住 = new Promise<void>((r) => (放行 = r));
    const 上 = 假上游(async (n) => {
      if (n === 1) await 卡住; // 中转站对第一份请求卡了 140 秒
      return 回文本('{"message":"好"}');
    });
    const qid = `q-slow-${Date.now()}`;
    const 桌面端 = new AbortController();
    const 原请求 = 打网关(qid, 桌面端.signal);
    while (上.次数() < 1) await 等一下(5);
    // 桌面端首轮 45 秒到点：断开，带同一个编号重发
    桌面端.abort(超时());
    const 重发 = await 打网关(qid);
    expect(重发.status).toBe(200);
    expect(await 用掉(账号.acc.id), "重发那次答出来时：扣了 1 次").toBe(1);
    // 原请求那份上游调用后来回来了
    放行();
    await 原请求;
    // 用户拿到了答案、上游被调了两次，账上却是 0：每个「首轮卡住」的问题都白送。
    // 反过来也是一条免费的路：任何客户端都可以「发 → 立刻断 → 同编号再发」，每个问题 0 次
    expect(await 用掉(账号.acc.id), "用户拿到了答案，应该净扣 1 次").toBe(1);
  });

  it("故意的：同一编号并发两份、断掉第一份——连问 5 个问题，账上 0 次", async () => {
    const 挂 = new Map<number, () => void>();
    const 上 = 假上游(async (n) => {
      if (n % 2 === 1) await new Promise<void>((r) => 挂.set(n, r));
      return 回文本('{"message":"好"}');
    });
    for (let i = 0; i < 5; i++) {
      const qid = `q-free-${Date.now()}-${i}`;
      const c = new AbortController();
      const 前 = 上.次数();
      const a = 打网关(qid, c.signal);
      while (上.次数() === 前) await 等一下(2);
      c.abort();
      expect((await 打网关(qid)).status).toBe(200);
      挂.get(前 + 1)!();
      await a;
    }
    expect(await 用掉(账号.acc.id), "5 个问题都拿到了答案").toBe(5);
  });
});

/* ---------------- 三、频率闸按问题算 ---------------- */

describe("网关：频率闸按问题算之后，同一个编号能不能绕过", () => {
  it("上游一直 502、客户端拿同一个编号死循环：40 次请求一次都没被频率闸拦（原来第 31 次就 429），而且全部退掉不扣", async () => {
    假上游(() => new Response("bad gateway", { status: 502 }));
    const qid = `q-loop-${Date.now()}`;
    const 状态: number[] = [];
    for (let i = 0; i < 40; i++) 状态.push((await 打网关(qid)).status);
    // 失控的循环脚本正是频率闸要防的（ai-quota.ts 文件头）；每问最多步 20 只决定「再扣一次」，挡不住请求本身，
    // 失败又全退，所以这条循环对用户 0 成本、对上游无上限
    expect(状态.filter((s) => s === 429).length, `状态：${[...new Set(状态)].join(",")}`).toBeGreaterThan(0);
  });

  it("上游正常、同一个编号连发 45 次：一次 429 都没有（只在每 20 次时多扣 1 次）", async () => {
    假上游(() => 回文本('{"message":"好"}'));
    const qid = `q-many-${Date.now()}`;
    const 状态: number[] = [];
    for (let i = 0; i < 45; i++) 状态.push((await 打网关(qid)).status);
    expect(状态.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});
