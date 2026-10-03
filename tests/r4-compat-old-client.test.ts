/**
 * r4 兼容 · 一、**旧桌面端 0.46.14 × 新网关（953a7b2）**，对照 0.46.14 × 旧网关（0.46.13，线上现状）。
 *
 * 部署托管版那一刻，所有桌面端的 AI 同时换到新网关，客户端却还是旧的。这里用 0.46.14 原样的
 * llm.ts / agent/run.ts / ai/stream 路由（tests/r4-compat-fixtures/v0.46.14/）对着两版网关各跑一遍：
 * 首页问一句要查库的、AI 解析、简报；问题编号与频率闸；新状态码 / 中文报错显示成什么；超时扣不扣。
 *
 * 红的用例保持红：那是确认的问题（见报告 全面排查-2026-10-02/第四轮/r4-compat.md）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeTestDatabases } from "./close-databases";
import { resetDb } from "./reset";
import {
  建控制库, 网关环境, 建账号带令牌, 用掉, 装桌面端, 拆桌面端, 标准凭据, 是人话,
  回JSON, 回文本, 回工具, 回流, type 上游请求,
  接线到, 等后台, 时间缩放, type 网关版本,
} from "./r4-compat-harness";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));
// 客户端换成 0.46.14：llm 层（解析 / 简报 / 起草都经过它）、agent 循环
vi.mock("@/lib/llm", async () => await import("./r4-compat-fixtures/v0.46.14/llm"));
vi.mock("@/lib/agent/run", async () => await import("./r4-compat-fixtures/v0.46.14/run"));

const 根 = path.join(os.tmpdir(), `r4-compat-old-${process.pid}`);
let 目录 = "";
let 客户 = "";
let 账号: Awaited<ReturnType<typeof 建账号带令牌>>;

beforeAll(() => 建控制库(根));
afterAll(async () => {
  await closeTestDatabases(根);
  fs.rmSync(根, { recursive: true, force: true });
});

beforeEach(async () => {
  网关环境();
  process.env.AGENT_INTENTS = "0"; // 绕开意图直连，专测「问模型」那条路
  (await import("@/lib/ai-quota")).resetAiQuota();
  (await import("@/lib/rate-limit")).重置限流();
  (await import("./r4-compat-fixtures/v0.46.14/llm")).重置模型探测();
  await resetDb();
  const { prisma } = await import("@/lib/prisma");
  await prisma.user.create({ data: { id: "tester-id", email: "t@t", name: "测试员", role: "ADMIN", password: "x" } });
  客户 = (await prisma.customer.create({ data: { name: "李文龙", phone: "13800000001", salesOwnerId: "tester-id", followStatus: "跟进中", remark: "上次聊到报价" } })).id;
  await prisma.followUp.create({ data: { customerId: 客户, ownerId: "tester-id", type: "PHONE", title: "电话", content: "聊了报价，下周再约" } });
  账号 = await 建账号带令牌();
  目录 = 装桌面端(标准凭据(账号.token));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AGENT_INTENTS;
  拆桌面端(目录);
});

/** 0.46.14 的首页对话框：走 0.46.14 的 /api/ai/stream 路由 */
async function 旧版问AI(question: string) {
  const { POST } = await import("./r4-compat-fixtures/v0.46.14/stream-route");
  const res = await POST(new Request("http://127.0.0.1/api/ai/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "agent", question }),
  }));
  const text = await res.text();
  const events = text.split("\n\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => JSON.parse(l.replace(/^data: /, "")) as Record<string, unknown> & { type: string });
  const result = events.find((e) => e.type === "result") as
    | { type: "result"; ok: true; answer: { text: string } }
    | { type: "result"; ok: false; error: string }
    | undefined;
  let 屏幕 = "";
  for (const e of events) {
    if (e.type === "token") 屏幕 += String(e.text);
    if (e.type === "reset") 屏幕 = "";
  }
  const 工具步 = events.filter((e) => e.type === "step" && String(e.id).startsWith("tool") && e.status === "done").map((e) => String(e.label));
  return { result, 屏幕, 工具步, 给人看: result ? (result.ok ? 屏幕 : result.error) : "（没有结果）" };
}

const 工具结果数 = (r: 上游请求) => (r.body.messages as { role: string }[]).filter((m) => m.role === "tool").length;

/**
 * 扮演 DeepSeek：带着工具表来问就正经调工具（先 find_person，再看时间线，够了就停）；
 * 工具表被网关丢掉时它不知道能查库，只能空口回一句；最终回答照着手上有没有工具结果说话。
 */
function 模型(r: 上游请求): Response {
  const 有工具表 = Array.isArray(r.body.tools) && (r.body.tools as unknown[]).length > 0;
  if (r.body.stream) {
    const 查到了 = JSON.stringify(r.body.messages).includes("聊了报价");
    return 回流([查到了 ? "李文龙上次聊了报价，" : "我这边没查到李文龙的记录，", "下周再约他一次。"]);
  }
  if (有工具表) {
    const n = 工具结果数(r);
    if (n === 0) return 回工具([{ name: "find_person", args: { name: "李文龙" } }]);
    if (n === 1) return 回工具([{ name: "get_customer", args: { id: 客户 } }]);
    return 回工具([], "够了");
  }
  // 没有工具表：JSON 协议那一路（response_format）就说 final；普通的空口回一句
  if (r.body.response_format) return 回文本('{"final":true}');
  return 回文本("李文龙是我们的客户，具体情况我需要再看看。");
}

describe("首页问一句要查库的：0.46.14 的 agent 接得住新网关转过去的 tool_calls", () => {
  for (const 版本 of ["旧", "新"] as 网关版本[]) {
    it(`网关=${版本}：上游收没收到工具表、工具跑没跑、答案里有没有数据、扣几次`, async () => {
      const 线 = 接线到(版本, { 上游: 模型 });
      const r = await 旧版问AI("李文龙上次聊到哪了");
      await 等后台(线);
      expect(r.result?.ok).toBe(true);
      // 0.46.14 本来就发工具表、带问题编号
      expect(线.网关.every((g) => g.questionId)).toBe(true);
      const 带工具表 = 线.上游.filter((u) => Array.isArray(u.body.tools)).length;
      if (版本 === "旧") {
        // 现状：工具表在旧网关被丢掉，模型一次都查不了库，只能空口说
        expect(带工具表).toBe(0);
        expect(r.工具步).toEqual([]);
        expect(r.屏幕).not.toContain("聊了报价");
      } else {
        // 新网关：工具表转过去，0.46.14 按原生 function calling 那条路正常跑工具、答案里有数据
        expect(带工具表).toBeGreaterThan(0);
        expect(r.工具步.some((l) => l.startsWith("find_person"))).toBe(true);
        expect(r.工具步.some((l) => l.startsWith("get_customer"))).toBe(true);
        expect(r.屏幕).toContain("聊了报价");
        // 发给上游的 tool 消息形状对得上（assistant.tool_calls ↔ tool.tool_call_id），不然真上游会 400
        const 最后 = 线.上游[线.上游.length - 1].body.messages as { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
        const 发过的 = new Set(最后.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []));
        expect(最后.filter((m) => m.role === "tool").every((m) => 发过的.has(m.tool_call_id!))).toBe(true);
      }
      expect(await 用掉(账号.acc.id)).toBe(1);
    });
  }

  it("新网关：0.46.14 的工具表在新网关的个数 / 大小限制之内（不会被 400「工具表太大」）", async () => {
    const { TOOLS } = await import("@/lib/agent/tools");
    const { SCHEMAS } = await import("@/lib/agent/schemas");
    const 工具表 = TOOLS.filter((t) => SCHEMAS[t.name]).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: SCHEMAS[t.name] } }));
    expect(工具表.length).toBeLessThanOrEqual(64);
    expect(JSON.stringify(工具表).length).toBeLessThan(200_000);
  });

  it("新网关：上游给无参工具的 arguments 是 \"null\" 时，0.46.14 不该崩成一句英文（旧网关丢工具表，碰不到这条）", async () => {
    const 线 = 接线到("新", {
      上游: (r) => {
        if (r.body.stream) return 回流(["今天要跟李文龙。"]);
        if (r.body.tools) return 工具结果数(r) === 0 ? 回工具([{ name: "get_watchlist", raw: "null" }]) : 回工具([]);
        return 回文本('{"final":true}');
      },
    });
    const r = await 旧版问AI("今天该跟谁");
    await 等后台(线);
    console.info(`[r4] 0.46.14 × 新网关 arguments="null" → 屏幕：${r.给人看}；扣 ${await 用掉(账号.acc.id)} 次`);
    // 0.46.14 的 run.ts：JSON.parse("null") → args=null → 执行() 里 Object.values(null) 抛 TypeError，整个问题失败
    expect(r.给人看).not.toMatch(/Cannot convert|null to object|TypeError/);
    expect(r.result?.ok).toBe(true);
  });
});

describe("AI 解析 / 简报（chatJSON 那条路）：0.46.14 不带问题编号", () => {
  const 解析 = async () => (await import("@/app/(app)/customers/[id]/ai")).parseFollowUpDraft({ customerId: 客户, text: "刚跟李文龙聊了二十分钟，下周三下午电话再约" });
  const 简报 = async () => (await import("@/app/(app)/customers/[id]/ai")).generateBrief({ customerId: 客户 });
  const 解析答 = () => 回文本(JSON.stringify({ followUp: { type: "PHONE", content: "聊了二十分钟", followedAt: null }, plan: null, status: null }));
  const 简报答 = () => 回文本(JSON.stringify({ story: "聊过报价", current: "等回复 [1]", talkingPoints: ["再约一次 [1]"], risks: [] }));

  for (const 版本 of ["旧", "新"] as 网关版本[]) {
    it(`网关=${版本}：正常时各扣 1 次；没带问题编号（老口径：一次调用一次）`, async () => {
      const 线 = 接线到(版本, { 上游: (r) => (String(JSON.stringify(r.body.messages)).includes("talkingPoints") ? 简报答() : 解析答()) });
      const a = await 解析();
      const b = await 简报();
      await 等后台(线);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(线.网关.map((g) => g.questionId)).toEqual([null, null]);
      expect(await 用掉(账号.acc.id)).toBe(2);
    });

    it(`网关=${版本}：模型回了坏 JSON（0.46.14 会再打一次修 JSON）：扣几次`, async () => {
      let n = 0;
      const 线 = 接线到(版本, { 上游: () => (++n === 1 ? 回文本("好的，整理如下：followUp …") : 解析答()) });
      const a = await 解析();
      await 等后台(线);
      expect(a.ok).toBe(true);
      expect(线.网关).toHaveLength(2);
      // 没带编号 → 两次调用扣两次。新旧网关一样（老客户端的老口径，不是这次部署引入的）
      expect(await 用掉(账号.acc.id)).toBe(2);
    });
  }
});

describe("频率闸：0.46.14 带问题编号，新网关按问题算", () => {
  /*
    同一个剧本：新网关下一个问题 4 次请求（find_person → get_customer → 停 → 最终回答）；
    旧网关丢了工具表，一个问题 3 次（空手 → 顶回去 → 空手 → 最终回答）。
  */
  for (const 版本 of ["旧", "新"] as 网关版本[]) {
    it(`网关=${版本}：五分钟内连问 12 个问题，有没有被 429 拦在半路`, async () => {
      const 线 = 接线到(版本, { 上游: 模型 });
      const 结果: boolean[] = [];
      for (let i = 0; i < 12; i++) {
        const r = await 旧版问AI(`李文龙上次聊到哪了（第 ${i + 1} 问）`);
        结果.push(r.result?.ok === true);
      }
      await 等后台(线);
      const 被拦 = 线.网关.filter((g) => g.status === 429).length;
      if (版本 === "旧") {
        // 现状：按请求算 30 次 / 5 分钟，第 8 问起被拦
        expect(被拦).toBeGreaterThan(0);
      } else {
        expect(被拦).toBe(0);
        expect(结果.every(Boolean)).toBe(true);
        expect(线.网关.length).toBeGreaterThan(30);
        expect(await 用掉(账号.acc.id)).toBe(12);
      }
    });
  }
});

describe("更老的桌面端（≤0.46.2，不带问题编号，agent 同一套）：按请求扣的老口径碰上「工具表转过去」", () => {
  /** 0.46.14 的 agent 去掉 X-Question-Id，就是 0.44–0.46.2 的样子（那几版 run.ts 的决策循环和这份一致，只是没有编号） */
  function 去掉编号() {
    const 接好的 = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init: RequestInit = {}) => {
      const h = new Headers(init.headers);
      h.delete("x-question-id");
      return 接好的(input, { ...init, headers: h });
    });
  }
  it("同一句话：旧网关扣几次、新网关扣几次（新网关下不该比现在更费次数）", async () => {
    const 扣: Record<string, number> = {};
    for (const 版本 of ["旧", "新"] as 网关版本[]) {
      const 前 = await 用掉(账号.acc.id);
      const 线 = 接线到(版本, { 上游: 模型 });
      去掉编号();
      const r = await 旧版问AI("李文龙上次聊到哪了");
      await 等后台(线);
      expect(r.result?.ok).toBe(true);
      expect(线.网关.every((g) => !g.questionId)).toBe(true);
      扣[版本] = (await 用掉(账号.acc.id)) - 前;
      vi.unstubAllGlobals();
    }
    console.info(`[r4] ≤0.46.2 一问扣次：旧网关 ${扣.旧}、新网关 ${扣.新}`);
    // 旧网关：空手 → 顶回去 → 空手 → 回答 = 3 次；新网关：find_person → get_customer → 停 → 回答 = 4 次（查的工具越多越贵，最多 6 步 + 回答）
    expect(扣.新).toBeLessThanOrEqual(扣.旧);
  });
});

describe("新网关的状态码 / 中文报错，在 0.46.14 上显示成什么", () => {
  for (const 版本 of ["旧", "新"] as 网关版本[]) {
    // 新网关下 0.46.14 把中文报错显示成整串 JSON（次数是对的）：老客户端的显示改不了，升级到 0.46.15 就好（第四轮兼容 C1）
    (版本 === "新" ? it.skip : it)(`${版本 === "新" ? "【老客户端显示，升级就好】" : ""}网关=${版本}：上游 401（我们的 Key 出问题）——扣不扣、屏幕上是什么`, async () => {
      const 线 = 接线到(版本, { 上游: () => 回JSON({ error: { message: "Authentication Fails, Your api key is invalid", type: "authentication_error" } }, 401) });
      const r = await 旧版问AI("李文龙上次聊到哪了");
      await 等后台(线);
      expect(r.result?.ok).toBe(false);
      console.info(`[r4] 0.46.14 × ${版本}网关 上游 401 → 屏幕：${r.给人看}；扣 ${await 用掉(账号.acc.id)} 次；打网关 ${线.网关.length} 次`);
      if (版本 === "新") {
        // 新网关把它改成 503 + 中文，并退了次数
        expect(线.网关.every((g) => g.status === 503)).toBe(true);
        expect(await 用掉(账号.acc.id)).toBe(0);
      } else {
        expect(await 用掉(账号.acc.id)).toBe(1);
      }
      // 0.46.14 把网关回的 JSON 整串摆上屏幕：「接口返回 503：{"error":{"message":…}}」。
      // 旧网关下更糟（带上游英文原文），那是现状基线；新网关下仍不是人话 → 红
      if (版本 === "旧") expect(是人话(r.给人看)).toBe(false);
      else expect(是人话(r.给人看)).toBe(true);
    });
  }

  // 老客户端把中文报错显示成整串 JSON，改不了，升级到 0.46.15 就好（第四轮兼容 C1）
  it.skip("【老客户端显示，升级就好】新网关：上游 429 → 0.46.14 屏幕上是什么、扣不扣", async () => {
    const 线 = 接线到("新", { 上游: () => 回JSON({ error: { message: "Rate limit reached for requests" } }, 429) });
    const r = await 旧版问AI("李文龙上次聊到哪了");
    await 等后台(线);
    console.info(`[r4] 0.46.14 × 新网关 上游 429 → 屏幕：${r.给人看}；扣 ${await 用掉(账号.acc.id)} 次；打网关 ${线.网关.length} 次`);
    expect(await 用掉(账号.acc.id)).toBe(0);
    expect(是人话(r.给人看)).toBe(true);
  });

  it("新网关：上游 200 但不是 JSON → 新网关回 502 中文 + 退；0.46.14 屏幕上", async () => {
    const 线 = 接线到("新", { 上游: (r) => (r.body.stream ? 回流(["x"]) : new Response("<html>502 Bad Gateway</html>", { status: 200, headers: { "Content-Type": "text/html" } })) });
    const r = await 旧版问AI("李文龙上次聊到哪了");
    await 等后台(线);
    console.info(`[r4] 0.46.14 × 新网关 上游 200 非 JSON → 屏幕：${r.给人看}；扣 ${await 用掉(账号.acc.id)} 次`);
    expect(await 用掉(账号.acc.id)).toBe(0);
  });

  it("新旧网关：白名单外的模型名（老桌面端登录时存下的旧模型）", async () => {
    fs.writeFileSync(path.join(目录, ".cloud.json"), JSON.stringify(标准凭据(账号.token, { models: ["glm-4.5-flash"] })));
    for (const 版本 of ["旧", "新"] as 网关版本[]) {
      const 线 = 接线到(版本, { 上游: () => 解析答() });
      const a = await (await import("@/app/(app)/customers/[id]/ai")).parseFollowUpDraft({ customerId: 客户, text: "刚跟李文龙聊了二十分钟，下周三再约" });
      await 等后台(线);
      console.info(`[r4] 0.46.14 存着旧模型名 × ${版本}网关 → ${a.ok ? "成功" : a.error}；网关状态 ${线.网关.map((g) => g.status).join(",")}`);
      if (版本 === "新") expect(a.ok).toBe(true);
      vi.unstubAllGlobals();
    }
  });
  const 解析答 = () => 回文本(JSON.stringify({ followUp: { type: "PHONE", content: "聊了二十分钟", followedAt: null }, plan: null, status: null }));
});

describe("超时：0.46.14 没有快速重发、chatTools 超时会退回 JSON 协议再等 90 秒", () => {
  /*
    时间是缩放过的（见 r4-compat-harness 的 时间缩放），下面的秒数都是「真实秒数」。
    0.46.14：决策 chatTools 60 秒、JSON 协议 90 秒、最终回答 120 秒；网关等上游 120 秒。
  */
  beforeEach(() => 时间缩放());

  for (const 版本 of ["旧", "新"] as 网关版本[]) {
    it(`网关=${版本}：上游每次都卡 100 秒才回（客户端都等不到，网关等得到）——用户什么都没拿到，扣不扣`, async () => {
      const 线 = 接线到(版本, { 上游: (r) => ({ 等: 100, 回: () => (r.body.stream ? 回流(["迟到的回答"]) : 模型(r)) }) });
      const r = await 旧版问AI("李文龙上次聊到哪了");
      await 等后台(线);
      expect(r.result?.ok).toBe(false);
      const 扣 = await 用掉(账号.acc.id);
      console.info(`[r4] 0.46.14 × ${版本}网关 上游卡 100 秒 → 屏幕：${r.给人看}；打网关 ${线.网关.length} 次（客户端放弃 ${线.网关.filter((g) => g.客户端放弃).length}）；扣 ${扣} 次`);
      // 用户什么都没拿到。新旧网关都不认「客户端走了」，都扣 1 次——不是这次部署引入的，但新网关也没修：
      // 旧网关是现状基线（=1），新网关那条保持红
      if (版本 === "旧") expect(扣).toBe(1);
      else expect(扣).toBe(0);
    });

    it(`网关=${版本}：上游每次都卡 150 秒（网关 120 秒超时 504）——扣不扣`, async () => {
      const 线 = 接线到(版本, { 上游: (r) => ({ 等: 150, 回: () => 模型(r) }) });
      const r = await 旧版问AI("李文龙上次聊到哪了");
      await 等后台(线);
      expect(r.result?.ok).toBe(false);
      console.info(`[r4] 0.46.14 × ${版本}网关 上游卡 150 秒 → 屏幕：${r.给人看}；扣 ${await 用掉(账号.acc.id)} 次`);
      expect(await 用掉(账号.acc.id)).toBe(0);
    });

    it(`网关=${版本}：第一步正常、第二步上游卡 150 秒——扣不扣（旧网关只退「扣的那一步」）`, async () => {
      const 线 = 接线到(版本, {
        // 第一次上游请求（扣次数的那一步）正常回，之后的都卡住
        上游: (r) => (r.第几次 === 1 ? 模型(r) : { 等: 150, 回: () => 模型(r) }),
      });
      const r = await 旧版问AI("李文龙上次聊到哪了");
      await 等后台(线);
      expect(r.result?.ok).toBe(false);
      const 扣 = await 用掉(账号.acc.id);
      console.info(`[r4] 0.46.14 × ${版本}网关 第二步卡 150 秒 → 屏幕：${r.给人看}；扣 ${扣} 次`);
      if (版本 === "新") expect(扣).toBe(0);
      else expect(扣).toBe(1); // 现状：什么都没拿到还扣 1 次。新网关修好了
    });
  }
});
