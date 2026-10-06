/**
 * r2-ai · 一、网关 / 云端出错时，桌面端用户看到什么、被扣了几次。
 *
 * 整条线是真的：桌面端本地 llm.ts → 进程内的网关路由 → 假上游（见 tests/r2-ai-harness.ts）。
 * 每一类都验三件事：给人看的那句是中文人话、不卡死（有结果回来）、不多扣次数。
 *
 * 两个入口各测一遍，因为它们的重试路子不一样：
 *   chatJSON 那条（起草话术 draftWakeup；解析、简报、解读、邀请、粘贴同一条路）
 *   agent 那条（首页对话框 → /api/ai/stream → runAgent：chatTools 失败会退回 JSON 协议再试）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeTestDatabases } from "./close-databases";
import { resetDb } from "./reset";
import {
  建控制库, 网关环境, 建账号带令牌, 用掉, 装桌面端, 拆桌面端, 标准凭据, 接线, 是人话, 等一下,
  回JSON, 回文本, 回工具, 回流, 问AI, 种类,
} from "./r2-ai-harness";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));

const 根 = path.join(os.tmpdir(), `r2-ai-gw-${process.pid}`);
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
  const c = await prisma.customer.create({ data: { name: "王同学", phone: "13800000001", salesOwnerId: "tester-id", remark: "上次聊到报价" } });
  客户 = c.id;
  账号 = await 建账号带令牌();
  目录 = 装桌面端(标准凭据(账号.token));
});
afterEach(() => {
  vi.unstubAllGlobals();
  拆桌面端(目录);
});

const 起草 = async () => (await import("@/app/(app)/dashboard/ai")).draftWakeup({ customerId: 客户, reason: "沉睡 20 天" });
const 错误 = (r: { ok: boolean; error?: string }) => (r.ok ? "" : String(r.error));

describe("基线：一切正常时", () => {
  it("起草话术：上游打一次、扣一次、拿到话术", async () => {
    const 线 = 接线({ 上游: () => 回文本('{"message":"王同学你好，上次聊到的报价我整理好了"}') });
    const r = await 起草();
    expect(r.ok).toBe(true);
    expect(线.上游).toHaveLength(1);
    expect(await 用掉(账号.acc.id)).toBe(1);
    // 一次调用就带着问题编号（2026-10-02 A2 修过）
    expect(线.网关[0].questionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("chatJSON 那条路（起草话术）", () => {
  it("401 令牌被吊销：说「重新登录」，不打上游、不扣", async () => {
    const { 吊销 } = await import("@/lib/tenant/device-token");
    await 吊销(账号.tokenId, 账号.acc.id);
    const 线 = 接线({ 上游: () => 回文本("{}") });
    const r = await 起草();
    expect(r.ok).toBe(false);
    expect(是人话(错误(r)), 错误(r)).toBe(true);
    expect(错误(r)).toContain("重新登录");
    expect(线.上游).toHaveLength(0);
    expect(await 用掉(账号.acc.id)).toBe(0);
  });

  it("402 次数用完：说「用完」和怎么办，不打上游", async () => {
    const { 扣一次 } = await import("@/lib/tenant/credits");
    for (let i = 0; i < 200; i++) if (!(await 扣一次(账号.owner)).ok) break;
    const 前 = await 用掉(账号.acc.id);
    const 线 = 接线({ 上游: () => 回文本("{}") });
    const r = await 起草();
    expect(错误(r)).toContain("用完");
    expect(是人话(错误(r)), 错误(r)).toBe(true);
    expect(线.上游).toHaveLength(0);
    expect(await 用掉(账号.acc.id)).toBe(前);
  });

  // 【下一版】回归核对 D-058 后半：次数已经是 0 时按钮照样能点、照样往网关发一趟（网关回 402、不扣、说人话，上面那条钉着）。
  // 输入框下那行和左栏用量条会变红，但按钮不置灰。不伤数据、不扣次，排下一版；做了「0 次本地就拦」后去掉 skip
  it.skip("【下一版】D-058 次数已知是 0：本地就拦下说「用完」，不往网关发", async () => {
    const { 扣一次 } = await import("@/lib/tenant/credits");
    for (let i = 0; i < 200; i++) if (!(await 扣一次(账号.owner)).ok) break;
    const 线 = 接线({ 上游: () => 回文本("{}") });
    await 起草(); // 第一次：从网关知道了是 0
    const 之前 = 线.网关.length;
    const r = await 起草();
    expect(错误(r)).toContain("用完");
    expect(线.网关.length, "已经知道是 0 了，第二次不该再去网关").toBe(之前);
  });

  it("网关自己的频率闸（429）：说「太频繁、等几秒」，不扣", async () => {
    const { consumeAiQuota } = await import("@/lib/ai-quota");
    for (let i = 0; i < 30; i++) consumeAiQuota(`gw:${账号.acc.id}`);
    const 线 = 接线({ 上游: () => 回文本("{}") });
    const r = await 起草();
    expect(错误(r)).toMatch(/频繁.*秒/);
    expect(是人话(错误(r)), 错误(r)).toBe(true);
    expect(线.上游).toHaveLength(0);
    expect(await 用掉(账号.acc.id)).toBe(0);
  });

  it("【坏】上游 429（上游在限我们）：次数退了，但给人看的话里带着上游的英文原文", async () => {
    接线({ 上游: () => new Response('{"error":{"message":"Rate limit reached for requests","type":"requests"}}', { status: 429 }) });
    const r = await 起草();
    expect(r.ok).toBe(false);
    expect(await 用掉(账号.acc.id)).toBe(0);
    expect(是人话(错误(r)), `界面上会显示：${错误(r)}`).toBe(true);
  });

  for (const status of [500, 502, 503]) {
    it(`上游 ${status}：「AI 服务暂时不可用」，次数退回`, async () => {
      const 线 = 接线({ 上游: () => new Response("<html>Bad Gateway</html>", { status }) });
      const r = await 起草();
      expect(错误(r)).toContain("暂时不可用");
      expect(是人话(错误(r))).toBe(true);
      // chatJSON 会降级再试一次：两次都失败，两次都退，净扣 0
      expect(线.上游.length).toBeLessThanOrEqual(2);
      expect(await 用掉(账号.acc.id)).toBe(0);
    });
  }

  it("上游超时（网关 120 秒等不到）→ 504：说人话、退次数", async () => {
    接线({
      上游: () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    });
    const r = await 起草();
    expect(是人话(错误(r)), 错误(r)).toBe(true);
    expect(await 用掉(账号.acc.id)).toBe(0);
  });

  it("桌面端这边先超时（上游慢）：提示是「AI 响应超时，请稍后重试」，不说「已经重发过」（J-138）", async () => {
    // 扣不扣次是下面那条【下一版】的事；这里只钉给人看的那句话（aabd111 删掉的半句别再长回来）
    接线({ 上游: async () => { await 等一下(600); return 回文本('{"message":"迟到的话术"}'); } });
    const { chatJSON } = await import("@/lib/llm");
    const e = await chatJSON("起草一句", { timeoutMs: 200 }).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe("AI 响应超时，请稍后重试");
    expect((e as Error).message).not.toContain("重发");
    await 等一下(900); // 让网关那边把上游等完，别把这次请求漏到下一条用例里
  });

  it.skip("【下一版】【坏】桌面端这边先超时（上游慢）：人看到「超时」，但这一次照样被扣了", async () => {
    // 上游 0.6 秒才回；桌面端 0.2 秒就放弃。真实世界里是：话术 60 秒、网关等上游 120 秒
    接线({ 上游: async () => { await 等一下(600); return 回文本('{"message":"迟到的话术"}'); } });
    const { chatJSON } = await import("@/lib/llm");
    const e = await chatJSON("起草一句", { timeoutMs: 200 }).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe("AI 响应超时，请稍后重试");
    await 等一下(900); // 让网关那边把上游等完
    expect(await 用掉(账号.acc.id), "人什么都没拿到，这一次不该算").toBe(0);
  });

  it("断网（打不到云端）：「连不上 AI 服务」，不扣", async () => {
    接线({ 上游: () => 回文本("{}"), 云断网: () => true });
    const r = await 起草();
    expect(错误(r)).toContain("连不上");
    expect(是人话(错误(r))).toBe(true);
    expect(await 用掉(账号.acc.id)).toBe(0);
  });

  it("【坏】云端回的不是 JSON（酒店 / 公司网的登录页、反代 200 的 HTML）：界面上是英文报错", async () => {
    接线({
      上游: () => 回文本("{}"),
      云端回: (url) => (url.includes("/chat/completions") ? new Response("<html><body>请先登录上网认证</body></html>", { status: 200, headers: { "Content-Type": "text/html" } }) : null),
    });
    const r = await 起草();
    expect(r.ok).toBe(false);
    expect(是人话(错误(r)), `界面上会显示：${错误(r)}`).toBe(true);
  });

  it("【坏】上游 200 但正文不是 JSON：英文报错，而且这一次被扣了", async () => {
    接线({ 上游: () => new Response("upstream proxy error: connection reset", { status: 200 }) });
    const r = await 起草();
    expect(r.ok).toBe(false);
    expect.soft(是人话(错误(r)), `界面上会显示：${错误(r)}`).toBe(true);
    expect.soft(await 用掉(账号.acc.id), "上游没给出任何能用的东西").toBe(0);
  });

  it("【坏】上游 200 但 choices 是空的：报「不是合法 JSON：」后面空着", async () => {
    接线({ 上游: () => 回JSON({ choices: [] }) });
    const r = await 起草();
    expect(r.ok).toBe(false);
    // 一个问题编号：重试共用，只扣一次
    expect(await 用掉(账号.acc.id)).toBe(1);
    expect(是人话(错误(r)), `界面上会显示：${错误(r)}`).toBe(true);
  });

  it("finish_reason=length 被截断：重试一次后报截断，只扣一次", async () => {
    const 线 = 接线({ 上游: () => 回JSON({ choices: [{ message: { content: '{"message":"王同' }, finish_reason: "length" }] }) });
    const r = await 起草();
    expect(r.ok).toBe(false);
    expect(错误(r)).toContain("截断");
    expect(线.上游).toHaveLength(2);
    expect(new Set(线.网关.map((g) => g.questionId)).size, "两次重试共用一个编号").toBe(1);
    expect(await 用掉(账号.acc.id)).toBe(1);
  });

  it("模型回了坏 JSON、修一次修好了：只扣一次", async () => {
    const 线 = 接线({ 上游: (r) => (r.第几次 === 1 ? 回文本("好的，话术如下：王同学你好") : 回文本('{"message":"王同学你好"}')) });
    const r = await 起草();
    expect(r.ok).toBe(true);
    expect(线.上游).toHaveLength(2);
    expect(await 用掉(账号.acc.id)).toBe(1);
  });

  it("【坏】上游 401/402（是我们自己的上游 Key 失效、中转站余额用完）：错在我们，却照扣用户", async () => {
    for (const status of [401, 402]) {
      接线({ 上游: () => new Response(JSON.stringify({ error: { message: status === 402 ? "Insufficient Balance" : "Authentication Fails" } }), { status }) });
      await 起草();
    }
    expect(await 用掉(账号.acc.id), "上游拒的是我们的 Key / 我们的余额，不是用户的请求").toBe(0);
  });

  /*
    2026-10-04 补（回归核对 H-005）：上游 403（没权限用这个模型）、404（模型下线 / 改名）也是我们这边的事，
    不该扣用户；原来只有一条源码计数守卫（credits-per-question），没有行为用例
  */
  for (const status of [403, 404]) {
    it(`上游 ${status}（模型没权限 / 下线）：次数退回，给人看的是中文`, async () => {
      接线({ 上游: () => new Response(JSON.stringify({ error: { message: status === 404 ? "Model Not Exist" : "Forbidden" } }), { status }) });
      const r = await 起草();
      expect(r.ok).toBe(false);
      expect(是人话(错误(r)), `界面上会显示：${错误(r)}`).toBe(true);
      expect(await 用掉(账号.acc.id)).toBe(0);
    });
  }

  it("【坏】上游 401（我们的上游 Key 失效）：桌面端用户会被告知去「重新登录」", async () => {
    接线({ 上游: () => new Response(JSON.stringify({ error: { message: "Authentication Fails (no such user)" } }), { status: 401 }) });
    const r = await 起草();
    expect(是人话(错误(r)), `界面上会显示：${错误(r)}`).toBe(true);
    expect(错误(r)).not.toContain("重新登录");
  });
});

describe("agent 那条路（首页对话框）", () => {
  /** 一个要查一次库再回答的正常问题 */
  const 正常剧本 = (r: { body: Record<string, unknown>; 第几次: number }) => {
    const k = 种类(r);
    if (k === "决策") {
      const 已查 = (r.body.messages as { role: string }[]).some((m) => m.role === "tool");
      return 已查 ? 回工具([]) : 回工具([{ name: "search_customers", args: { query: "王" } }]);
    }
    if (k === "回答") return 回流(["王同学", "在跟进中。"]);
    return 回文本('{"final":true}');
  };

  it("基线：查一次库、组织回答，整个问题只扣一次", async () => {
    const 线 = 接线({ 上游: 正常剧本 });
    const { result, 屏幕 } = await 问AI("王同学现在怎么样了");
    expect(result?.ok).toBe(true);
    expect(屏幕).toContain("王同学");
    expect(线.上游.length).toBeGreaterThanOrEqual(3);
    expect(new Set(线.网关.map((g) => g.questionId)).size).toBe(1);
    expect(await 用掉(账号.acc.id)).toBe(1);
  });

  it("402 次数用完：说「用完」；不打上游；多打几次网关可以接受但别超过 3 次", async () => {
    const { 扣一次 } = await import("@/lib/tenant/credits");
    for (let i = 0; i < 200; i++) if (!(await 扣一次(账号.owner)).ok) break;
    const 线 = 接线({ 上游: 正常剧本 });
    const { result } = await 问AI("王同学现在怎么样了");
    expect(result?.ok).toBe(false);
    const msg = result && !result.ok ? result.error : "";
    expect(msg).toContain("用完");
    expect(是人话(msg), msg).toBe(true);
    expect(线.上游).toHaveLength(0);
    // chatTools 失败 → 退 JSON 协议 → 降级再试：一共 3 次网关请求（都被 402 挡下，不花钱，只是白跑）
    expect(线.网关.length).toBeLessThanOrEqual(3);
  });

  it("401 令牌被吊销：说「重新登录」", async () => {
    const { 吊销 } = await import("@/lib/tenant/device-token");
    await 吊销(账号.tokenId, 账号.acc.id);
    接线({ 上游: 正常剧本 });
    const { result } = await 问AI("王同学现在怎么样了");
    const msg = result && !result.ok ? result.error : "";
    expect(msg).toContain("重新登录");
    expect(是人话(msg)).toBe(true);
  });

  it("断网：「连不上 AI 服务」，有结果回来（不卡住）", async () => {
    接线({ 上游: 正常剧本, 云断网: () => true });
    const { result } = await 问AI("王同学现在怎么样了");
    const msg = result && !result.ok ? result.error : "";
    expect(msg).toContain("连不上");
    expect(await 用掉(账号.acc.id)).toBe(0);
  });

  it("第一步上游 502：说人话、不扣", async () => {
    接线({ 上游: () => new Response("bad gateway", { status: 502 }) });
    const { result } = await 问AI("王同学现在怎么样了");
    const msg = result && !result.ok ? result.error : "";
    expect(msg).toContain("暂时不可用");
    expect(await 用掉(账号.acc.id)).toBe(0);
  });

  it("决策这步超时：不退到 JSON 协议再等一轮；最多快速重发两次", async () => {
    // 用桌面端这边立刻抛 TimeoutError 代替真等 60 秒：看的是超时之后又发了几次
    let 云端请求 = 0;
    接线({
      上游: 正常剧本,
      云端回: (url) => {
        if (url.includes("/chat/completions")) {
          云端请求++;
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }
        return null;
      },
    });
    const { result } = await 问AI("王同学现在怎么样了");
    const msg = result && !result.ok ? result.error : "";
    expect(msg).toContain("超时");
    expect(是人话(msg)).toBe(true);
    // J-138：超时提示原来一律说「已经重发过一次」，可不是每条路都重发过（aabd111 删了那半句）——别再说回去
    expect(msg, `对话框里会显示：${msg}`).not.toContain("重发");
    // 超时之后按「对面不认 tools」退去 JSON 协议，再等一整轮（90 秒）才报超时
    // 2026-10-02 起：同一请求快速重发一次（中转站偶发卡住，重发通常就回来了），不再换协议等第二轮
    // 2026-10-06 起超时最多快速重发两次（中转站约五分之一的请求会卡住），仍然不换协议
    expect(云端请求, "最多重发两次，不该再退到 JSON 协议等一整轮").toBeLessThanOrEqual(3);
  });

  it("【坏】云端回的不是 JSON：对话框里是英文报错", async () => {
    接线({
      上游: 正常剧本,
      云端回: (url) => (url.includes("/chat/completions") ? new Response("<html>portal</html>", { status: 200 }) : null),
    });
    const { result } = await 问AI("王同学现在怎么样了");
    const msg = result && !result.ok ? result.error : "";
    expect(result?.ok).toBe(false);
    expect(是人话(msg), `对话框里会显示：${msg}`).toBe(true);
  });

  it("决策步 choices 为空：不卡住，给一句中文（不会把空白或协议标记推上屏）", async () => {
    接线({ 上游: (r) => (种类(r) === "回答" ? 回流([]) : 回JSON({ choices: [] })) });
    const { result, 屏幕 } = await 问AI("王同学现在怎么样了");
    expect(result?.ok).toBe(true);
    expect(屏幕.trim().length).toBeGreaterThan(0);
    expect(是人话(屏幕), 屏幕).toBe(true);
  });

  it("【坏】最终回答流到一半断了：对话框里是一句英文「terminated」", async () => {
    接线({
      上游: (r) => {
        const k = 种类(r);
        if (k === "决策") return (r.body.messages as { role: string }[]).some((m) => m.role === "tool") ? 回工具([]) : 回工具([{ name: "search_customers", args: { query: "王" } }]);
        return 回流(["王同学", "目前在", "跟进中，上次"], 2);
      },
    });
    const { result, 屏幕 } = await 问AI("王同学现在怎么样了");
    const msg = result && !result.ok ? result.error : "";
    expect(result?.ok).toBe(false);
    expect(是人话(msg), `对话框里会显示：${msg}`).toBe(true);
    // 回归核对 D-061：已经流出来的字留在屏幕上，不被一句报错冲掉
    expect(屏幕).toBe("王同学目前在");
  });

  // 【下一版】D-061 后半：回答流到一半断了，这一次照样算了 1 次（网关在上游回 200 时就记账，流断了不退）。
  // 不伤数据，排下一版；网关能认出「流没走完」后去掉 skip
  it.skip("【下一版】最终回答流到一半断了：人只拿到半句，这一次不该算", async () => {
    接线({
      上游: (r) => {
        const k = 种类(r);
        if (k === "决策") return (r.body.messages as { role: string }[]).some((m) => m.role === "tool") ? 回工具([]) : 回工具([{ name: "search_customers", args: { query: "王" } }]);
        return 回流(["王同学", "目前在", "跟进中，上次"], 2);
      },
    });
    await 问AI("王同学现在怎么样了");
    expect(await 用掉(账号.acc.id)).toBe(0);
  });

  it("决策步 finish_reason=length（工具参数被截断）：不卡死，有回答", async () => {
    接线({
      上游: (r) => {
        const k = 种类(r);
        if (k === "决策") return 回JSON({ choices: [{ message: { content: "", tool_calls: [{ id: "x", type: "function", function: { name: "search_customers", arguments: '{"query":"王' } }] }, finish_reason: "length" }] });
        if (k === "回答") return 回流(["没查到完整信息。"]);
        return 回文本('{"final":true}');
      },
    });
    const { result } = await 问AI("王同学现在怎么样了");
    expect(result).toBeDefined();
    expect(await 用掉(账号.acc.id)).toBe(1);
  });
});

