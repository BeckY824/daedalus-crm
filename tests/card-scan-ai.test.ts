/**
 * 扫名片的 AI 整理（2026-10-20 用户定「用 AI，免费不扣次数」，只给团队版）：
 *   - lib/card-scan/ai.ts：模型只回行号，验回答（行号越界、乱回、行业不在选项里）；合进规则的字段时值一律从 OCR 原文拿，号码照旧听规则
 *   - lib/card-scan/server/ai-call.ts：超时、非 200、不是 JSON 都返回 null（手机用规则），不抛；不打名片内容；回了用量就记一笔 AiCall（card-scan）
 *   - app/api/mobile/scan/ai：只给团队版令牌、没配模型 404、太长 413、看不懂 400、按账号限次 429
 *   - lib/card-scan/cloud.ts 服务器整理：不给用记下不再问；出错一律 null
 * 用的是 tests/fixtures/card-scan 里编的演示名片，不含真名片
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { 拆字段, type 框 } from "@/lib/card-scan/parse";
import { 名片行们, 验AI回答, 合AI, AI用户消息, AI系统提示, type AI回答 } from "@/lib/card-scan/ai";
import { AI整理名片, 整理配置, 默认模型 } from "@/lib/card-scan/server/ai-call";
import 二十张 from "./fixtures/card-scan/v6tiny-20张.json";

type 样 = { id: string; 框们: 框[] };
const 英框 = (二十张 as unknown as 样[]).find((x) => x.id === "02-en-uk")!.框们;
const 行们 = 名片行们(英框);
const 号 = (re: RegExp) => 行们.findIndex((l) => re.test(l.text));
const TRADE = ["外贸 / 进出口", "制造业", "其他"];

describe("名片行 / 提示词", () => {
  it("行号和拆字段同一个顺序；号码那几行标了联系方式；照片、坐标不在里面", () => {
    expect(行们.length).toBe(英框.length);
    expect(行们.find((l) => l.text.includes("@"))?.联系方式).toBe(true);
    expect(行们.find((l) => l.text === "Oliver Bennett")?.联系方式).toBe(false);
    const 消息 = AI用户消息(行们);
    expect(消息.split("\n")).toHaveLength(行们.length);
    expect(消息).not.toMatch(/cx|cy|poly/);
    expect(AI系统提示(TRADE)).toContain("外贸 / 进出口、制造业、其他");
  });
});

describe("验AI回答", () => {
  it("行号越界、重复、不是数字的丢掉；行业不在选项里的丢掉；译文截长度", () => {
    const r = 验AI回答({ 公司: [[1, 1, 99, "x"]], 联系人: [{ 名字: [0], 职位: [2, -1] }, { 名字: [] }], 地址: [3], 标语: [], 行业: "瞎编行业", 译: { 公司: "a".repeat(500) } }, 5, TRADE);
    expect(r).toMatchObject({ 公司: [[1]], 联系人: [{ 名字: [0], 职位: [2] }], 地址: [3], 行业: "" });
    expect(r!.译.公司).toHaveLength(200);
    expect(验AI回答({ 公司: [], 联系人: [], 行业: "制造业" }, 5, TRADE)!.行业).toBe("制造业");
  });
  it("整个不像样：null（用规则）", () => {
    expect(验AI回答(null, 5, TRADE)).toBeNull();
    expect(验AI回答("公司是 Acme", 5, TRADE)).toBeNull();
    expect(验AI回答({ 名字: "Oliver" }, 5, TRADE)).toBeNull();
  });
});

describe("合AI", () => {
  const 规则 = 拆字段(英框);
  const 答 = (x: Partial<AI回答>): AI回答 => ({ 公司: [], 联系人: [], 地址: [], 标语: [], 行业: "", 译: { 公司: "", 名字: "", 职位: "", 地址: "" }, ...x });
  it("公司 / 名字 / 职位的值从 OCR 那一行拿（模型改写不了原文），号码、邮箱照旧听规则", () => {
    const { 字段, 附加 } = 合AI(规则, 英框, 答({
      公司: [[号(/Harbourline Lighting/)]], 联系人: [{ 名字: [号(/^Oliver Bennett$/)], 职位: [号(/Purchasing/)] }], 行业: "制造业",
    }));
    expect(字段).toMatchObject({ name: "Oliver Bennett", company: "Harbourline Lighting Ltd", title: "Purchasing Manager", email: 规则.email, phones: 规则.phones, whatsapp: 规则.whatsapp });
    expect(附加.行业).toBe("制造业");
  });
  it("AI 说是标语的行不进备注；名片上第二个人进 别的联系人", () => {
    const 某行 = 行们.findIndex((l) => !l.联系方式 && !/Oliver|Harbourline|Purchasing/.test(l.text));
    const 规则带剩 = { ...规则, 剩下: [...规则.剩下, 行们[某行].text] };
    const { 字段, 附加 } = 合AI(规则带剩, 英框, 答({ 联系人: [{ 名字: [号(/^Oliver Bennett$/)], 职位: [] }, { 名字: [某行], 职位: [] }], 标语: [] }));
    expect(字段.剩下).not.toContain(行们[某行].text);
    expect(附加.别的联系人).toEqual([行们[某行].text]);
  });
  it("AI 说名片上没有人：规则认的人名在 AI 说的公司行里（规则把公司当人名）就清掉；不在的（AI 漏了人名）留着", () => {
    const 公司行 = 号(/Harbourline Lighting/);
    const 误认 = { ...规则, name: "Harbourline Lighting Ltd" };
    expect(合AI(误认, 英框, 答({ 公司: [[公司行]] })).字段.name).toBeNull();
    expect(合AI(规则, 英框, 答({ 公司: [[公司行]] })).字段.name).toBe("Oliver Bennett");
  });
  it("一项里混了几种文字（双语名片中英文名并成一项）：拆成几种写法，中文名、拉丁字母的在前；被包含的 logo 字去掉", () => {
    const 框们 = [
      { text: "บริษัท สยามซีฟูด จำกัด", cx: 300, cy: 100, w: 400, h: 30, score: 0.95, side: 0 },
      { text: "Siam Seafood Co., Ltd.", cx: 300, cy: 140, w: 400, h: 30, score: 0.95, side: 0 },
      { text: "Siam", cx: 100, cy: 40, w: 80, h: 40, score: 0.95, side: 0 },
    ] as unknown as 框[];
    const 行 = 名片行们(框们);
    const k = (t: string) => 行.findIndex((l) => l.text === t);
    const 规则0 = 拆字段(框们);
    const { 字段 } = 合AI(规则0, 框们, 答({ 公司: [[k("บริษัท สยามซีฟูด จำกัด"), k("Siam Seafood Co., Ltd."), k("Siam")]] }));
    expect([字段.company, ...字段.companyAlt]).toEqual(["Siam Seafood Co., Ltd.", "บริษัท สยามซีฟูด จำกัด"]);
  });
});

describe("AI整理名片（服务器调模型）", () => {
  const env = { CARD_SCAN_AI_KEY: "k", CARD_SCAN_AI_BASE_URL: "https://up.example/v1/" } as unknown as NodeJS.ProcessEnv;
  const 回 = (content: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status }));
  let 警告: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { 警告 = vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { 警告.mockRestore(); });

  it("配置：自己的 Key 优先；没有就借网关；都没有 null。模型默认 默认模型", () => {
    expect(整理配置(env)).toEqual({ apiKey: "k", baseUrl: "https://up.example/v1", model: 默认模型 });
    expect(整理配置({ GATEWAY_API_KEY: "g", GATEWAY_BASE_URL: "https://gw.example/v1", CARD_SCAN_AI_MODEL: "gpt-5-mini" } as unknown as NodeJS.ProcessEnv)).toMatchObject({ apiKey: "g", model: "gpt-5-mini" });
    expect(整理配置({} as NodeJS.ProcessEnv)).toBeNull();
    // 线上临时关掉（背调还要用网关的 Key，不能拿掉 Key 来关）
    expect(整理配置({ ...env, CARD_SCAN_AI_OFF: "1" } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
  it("回的 JSON 验过再给；请求里只有文字行，要 JSON、低推理", async () => {
    const 抓 = 回({ 公司: [[1]], 联系人: [], 行业: "其他" });
    expect(await AI整理名片(行们, TRADE, { 抓, env })).toMatchObject({ 公司: [[1]], 行业: "其他" });
    const [url, init] = 抓.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://up.example/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 默认模型, response_format: { type: "json_object" }, reasoning_effort: "low" });
    expect(body.messages[1].content).toContain("Oliver Bennett");
  });
  it("非 200、不是 JSON、超时：null，不抛；日志里没有名片上的字", async () => {
    expect(await AI整理名片(行们, TRADE, { 抓: 回({}, 500), env })).toBeNull();
    expect(await AI整理名片(行们, TRADE, { 抓: vi.fn(async () => new Response("<html>")), env })).toBeNull();
    const 慢 = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_r, 拒) => init?.signal?.addEventListener("abort", () => 拒(init.signal!.reason))));
    const 起 = Date.now();
    expect(await AI整理名片(行们, TRADE, { 抓: 慢 as unknown as typeof fetch, env, 超时: 50 })).toBeNull();
    expect(Date.now() - 起).toBeLessThan(1000);
    expect(JSON.stringify(警告.mock.calls)).not.toMatch(/Oliver|Harbourline|@/);
  });
  it("回了用量：记一笔 AiCall 到这个账号（feature=card-scan）；没回用量、没给归属都不记", async () => {
    假.记账 = [];
    const 带用量 = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ 公司: [[1]], 联系人: [], 行业: "其他" }) } }], usage: { prompt_tokens: 900, completion_tokens: 60 } })));
    await AI整理名片(行们, TRADE, { 抓: 带用量, env, 记在: { kind: "account", id: "acct_1" } });
    expect(假.记账).toEqual([[{ kind: "account", id: "acct_1" }, { model: 默认模型, usage: { input: 900, output: 60 }, feature: "card-scan" }]]);
    await AI整理名片(行们, TRADE, { 抓: 带用量, env });
    await AI整理名片(行们, TRADE, { 抓: 回({ 公司: [[1]], 联系人: [], 行业: "其他" }), env, 记在: { kind: "account", id: "acct_1" } });
    expect(假.记账).toHaveLength(1);
  });
  it("没配 Key：不发请求，null", async () => {
    const 抓 = 回({});
    expect(await AI整理名片(行们, TRADE, { 抓, env: {} as NodeJS.ProcessEnv })).toBeNull();
    expect(抓).not.toHaveBeenCalled();
  });
});

// ---------- 接口 ----------
const 假 = vi.hoisted(() => ({ 多租户: true, 令牌: new Map<string, string>(), 资格: new Map<string, string>(), 答: null as unknown, 记账: [] as unknown[] }));
vi.mock("@/lib/tenant/ai-cost", async (原) => ({ ...(await 原<typeof import("@/lib/tenant/ai-cost")>()), 记一次: async (...a: unknown[]) => { 假.记账.push(a); } }));
vi.mock("@/lib/tenant/context", () => ({ multiTenant: () => 假.多租户 }));
vi.mock("@/lib/tenant/device-token", () => ({
  取Bearer: (req: Request) => /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null,
  认领: async (t: string | null) => (t && 假.令牌.has(t) ? { id: "tok", accountId: 假.令牌.get(t)! } : null),
}));
vi.mock("@/lib/tenant/mobile-link", () => ({ 连手机资格: async (a: string) => 假.资格.get(a) ?? "no-team" }));

describe("/api/mobile/scan/ai", () => {
  let 路由: typeof import("@/app/api/mobile/scan/ai/route");
  beforeEach(async () => {
    假.多租户 = true;
    假.令牌 = new Map([["dk_team", "acct_team"], ["dk_solo", "acct_solo"]]);
    假.资格 = new Map([["acct_team", "ok"]]);
    假.答 = { 公司: [[0]], 联系人: [], 行业: "制造业" };
    vi.stubEnv("CARD_SCAN_AI_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(假.答) } }] }))));
    vi.resetModules();
    路由 = await import("@/app/api/mobile/scan/ai/route");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  const 发 = (令牌: string | null, body: unknown = { 行们: 行们.slice(0, 3), 行业们: TRADE }) =>
    路由.POST(new Request("http://x/api/mobile/scan/ai", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: 令牌 ? { authorization: `Bearer ${令牌}` } : {} }));

  it("团队版：回验过的答；行业不在这个团队的选项里就丢掉", async () => {
    const r = await 发("dk_team");
    expect(r.status).toBe(200);
    expect((await r.json()).答).toMatchObject({ 公司: [[0]], 行业: "制造业" });
    const r2 = await 发("dk_team", { 行们: 行们.slice(0, 3), 行业们: ["其他"] });
    expect((await r2.json()).答.行业).toBe("");
  });
  it("自部署 404、没令牌 401、不是团队版 403；GET 报能不能用", async () => {
    expect((await 发(null)).status).toBe(401);
    expect((await 发("dk_solo")).status).toBe(403);
    const g = await 路由.GET(new Request("http://x/api/mobile/scan/ai", { headers: { authorization: "Bearer dk_team" } }));
    expect(await g.json()).toEqual({ ok: true });
    假.多租户 = false;
    expect((await 发("dk_team")).status).toBe(404);
  });
  it("服务器没配模型：404（手机记下不再问）", async () => {
    vi.stubEnv("CARD_SCAN_AI_KEY", "");
    vi.stubEnv("GATEWAY_API_KEY", "");
    expect((await 发("dk_team")).status).toBe(404);
  });
  it("看不懂 400、太长 413、行太多 400", async () => {
    expect((await 发("dk_team", "{不是 json")).status).toBe(400);
    expect((await 发("dk_team", { 行们: [{ 字号: 3 }] })).status).toBe(400);
    expect((await 发("dk_team", { 行们: Array.from({ length: 81 }, () => ({ text: "x" })) })).status).toBe(400);
    expect((await 发("dk_team", { 行们: [{ text: "x".repeat(20_000) }] })).status).toBe(413);
  });
  it("模型没回：答 null（手机用规则），不是错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await 发("dk_team");
    expect(r.status).toBe(200);
    expect((await r.json()).答).toBeNull();
    warn.mockRestore();
  });
  it("按账号 10 分钟 60 张：第 61 张 429", async () => {
    for (let i = 0; i < 60; i++) expect((await 发("dk_team")).status).toBe(200);
    expect((await 发("dk_team")).status).toBe(429);
  });
});

describe("服务器整理（手机这头）", () => {
  let 云: typeof import("@/lib/card-scan/cloud");
  beforeEach(async () => { vi.resetModules(); 云 = await import("@/lib/card-scan/cloud"); });

  it("没令牌不问；不给用（404）记下、这次打开期间不再问；出错 null", async () => {
    const 抓 = vi.fn(async () => new Response("", { status: 404 }));
    expect(await 云.服务器整理(行们, TRADE, { 抓 })).toBeNull();
    expect(抓).not.toHaveBeenCalled();
    云.设识别令牌("dk_team");
    expect(await 云.服务器整理(行们, TRADE, { 抓 })).toBeNull();
    expect(await 云.服务器整理(行们, TRADE, { 抓 })).toBeNull();
    expect(抓).toHaveBeenCalledTimes(1);
    // 换了令牌（重新登录）再问
    云.设识别令牌("dk_other");
    const 好 = vi.fn(async () => new Response(JSON.stringify({ 答: { 公司: [[0]] } })));
    expect(await 云.服务器整理(行们, TRADE, { 抓: 好 })).toEqual({ 公司: [[0]] });
    expect(await 云.服务器整理(行们, TRADE, { 抓: vi.fn(async () => { throw new TypeError("断网"); }) })).toBeNull();
  });
});
