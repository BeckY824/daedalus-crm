/**
 * 服务器认名片（2026-10-20，用户同意「服务器识别为主、本机识别兜底」）：
 *   - lib/card-scan/server/pool.ts：同一时间认 N 张、其余排队报位置；排太多 / 排太久回「太忙」；手机走了撤掉；线程挂了 / 卡住重起；闲了关线程
 *   - app/api/mobile/scan：只给团队版令牌（自部署 404、没令牌 401、不是团队版 403）、按账号限次、照片大小上限、一行一行回排队和结果
 *   - lib/card-scan/cloud.ts：手机这头读排队位置；服务器不给用 / 忙 / 断了都抛 服务器不认（认名片改在手机上认）
 *   - 真认一张（ocr-server/worker.mjs 打过才跑：next dev / build 会打；CI 上由托管版 e2e 真跑接口）
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { 建池, 太忙, type 识别池 } from "@/lib/card-scan/server/pool";

const 替身 = path.join(__dirname, "fixtures/ocr-fake-worker.mjs");
const 图 = new Uint8Array(10);

describe("识别线程池", () => {
  let 池: 识别池;
  afterEach(async () => { await 池?.关(); });

  it("一个线程：按先后认，排着的知道前面还有几张，轮到了报 0", async () => {
    池 = 建池({ 线程数: 1, worker路径: 替身 });
    const 位置: Record<string, number[]> = { a: [], b: [], c: [] };
    const 认 = (k: string) => 池.认(图, `好:60`, { 进: (x) => 位置[k].push(x) }).then((r) => `${k}:${r[0].text}`);
    const 结果 = await Promise.all([认("a"), 认("b"), 认("c")]);
    expect(结果).toEqual(["a:好:60#10", "b:好:60#10", "c:好:60#10"]);
    expect(位置.a).toEqual([0]);
    expect(位置.b.at(-1)).toBe(0);
    expect(位置.b).toContain(1);
    expect(位置.c).toContain(2);
    expect(位置.c).toContain(1);
    expect(位置.c.at(-1)).toBe(0);
  });

  it("两个线程：两张一起认", async () => {
    池 = 建池({ 线程数: 2, worker路径: 替身 });
    const 起 = Date.now();
    await Promise.all([池.认(图, "好:300"), 池.认(图, "好:300")]);
    expect(Date.now() - 起).toBeLessThan(550);
    expect(池.状态().线程).toBe(2);
  });

  it("排的太多：当场回太忙（手机改用本机）", async () => {
    池 = 建池({ 线程数: 1, 最多排: 1, worker路径: 替身 });
    const 一 = 池.认(图, "好:200");
    const 二 = 池.认(图, "好:10");
    await expect(池.认(图, "好:10")).rejects.toBeInstanceOf(太忙);
    await Promise.all([一, 二]);
  });

  it("排太久：回太忙，不再占着队", async () => {
    池 = 建池({ 线程数: 1, 等太久毫秒: 80, worker路径: 替身 });
    const 一 = 池.认(图, "好:400");
    await expect(池.认(图, "好:10")).rejects.toBeInstanceOf(太忙);
    expect(池.状态().排队).toBe(0);
    await 一;
  });

  it("手机走了（断开）：从队里撤掉，后面的往前挪", async () => {
    池 = 建池({ 线程数: 1, worker路径: 替身 });
    const 停 = new AbortController();
    const 位置: number[] = [];
    const 一 = 池.认(图, "好:200");
    const 二 = 池.认(图, "好:10", { signal: 停.signal });
    const 三 = 池.认(图, "好:10", { 进: (x) => 位置.push(x) });
    停.abort();
    await expect(二).rejects.toThrow("取消了");
    await Promise.all([一, 三]);
    expect(位置.slice(0, 2)).toEqual([2, 1]);
  });

  it("线程挂了：这张报错，下一张照样认（线程重起）", async () => {
    池 = 建池({ 线程数: 1, worker路径: 替身 });
    await expect(池.认(图, "崩")).rejects.toThrow(/识别线程退出/);
    expect((await 池.认(图, "好:1"))[0].text).toBe("好:1#10");
  });

  it("一张卡住：超时报错，线程重起，下一张照样认", async () => {
    池 = 建池({ 线程数: 1, 认太久毫秒: 150, worker路径: 替身 });
    const 二 = 池.认(图, "好:1");
    await expect(池.认(图, "卡")).rejects.toThrow("识别超时");
    expect((await 二)[0].text).toBe("好:1#10");
  });

  it("认不了（模型报错）：这张报错，线程还在", async () => {
    池 = 建池({ 线程数: 1, worker路径: 替身 });
    await expect(池.认(图, "坏")).rejects.toThrow("认不了");
    expect(池.状态().线程).toBe(1);
  });

  it("闲了一阵：线程全关掉，把内存还回去；再来一张又起", async () => {
    池 = 建池({ 线程数: 1, 闲多久关毫秒: 60, worker路径: 替身 });
    await 池.认(图, "好:1");
    expect(池.状态().线程).toBe(1);
    await new Promise((ok) => setTimeout(ok, 200));
    expect(池.状态().线程).toBe(0);
    await 池.认(图, "好:1");
    expect(池.状态().线程).toBe(1);
  });
});

const 真线程 = path.resolve(__dirname, "../ocr-server/worker.mjs");
describe.skipIf(!fs.existsSync(真线程))("真认一张（ocr-server/worker.mjs）", () => {
  it("英文名片：和手机上认的一样（PP-OCRv6 tiny）", async () => {
    const 池 = 建池({ 线程数: 1, 模型目录: path.resolve(__dirname, "../public/ocr/v1/models"), worker路径: 真线程 });
    try {
      const 项们 = await 池.认(fs.readFileSync(path.resolve(__dirname, "../e2e/fixtures/cards/02-en-uk.jpg")), "PP-OCRv6_tiny");
      const 字 = 项们.map((x) => x.text);
      expect(字).toContain("Oliver Bennett");
      expect(字.join("\n")).toContain("oliver.bennett@harbourline.co.uk");
      await expect(池.认(new Uint8Array([1, 2, 3]), "PP-OCRv6_tiny")).rejects.toThrow();
      await expect(池.认(图, "../../etc")).rejects.toThrow("不认识的识别模型");
    } finally {
      await 池.关();
    }
  }, 60_000);
});

// ---------- 接口 ----------
const 假 = vi.hoisted(() => ({
  多租户: true,
  令牌: new Map<string, string>(),
  资格: new Map<string, string>(),
  认: null as null | ((图: Uint8Array, 模型: string, o: { signal?: AbortSignal; 进?: (n: number) => void }) => Promise<unknown>),
  预热: 0,
}));
vi.mock("@/lib/tenant/context", () => ({ multiTenant: () => 假.多租户 }));
vi.mock("@/lib/tenant/device-token", () => ({
  取Bearer: (req: Request) => /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null,
  认领: async (t: string | null) => (t && 假.令牌.has(t) ? { id: "tok", accountId: 假.令牌.get(t)! } : null),
}));
vi.mock("@/lib/tenant/mobile-link", () => ({ 连手机资格: async (a: string) => 假.资格.get(a) ?? "no-team" }));
vi.mock("@/lib/card-scan/server/pool", async (原) => ({
  ...(await 原<typeof import("@/lib/card-scan/server/pool")>()),
  取识别池: () => ({ 认: (...a: Parameters<NonNullable<typeof 假.认>>) => 假.认!(...a), 预热: () => { 假.预热++; } }),
}));

describe("POST /api/mobile/scan", () => {
  let 路由: typeof import("@/app/api/mobile/scan/route");
  beforeEach(async () => {
    假.多租户 = true;
    假.令牌 = new Map([["dk_team", "acct_team"], ["dk_solo", "acct_solo"], ["dk_team2", "acct_team2"]]);
    假.资格 = new Map([["acct_team", "ok"], ["acct_team2", "ok"]]);
    假.认 = async (_图, 模型, o) => { o.进?.(2); o.进?.(1); o.进?.(0); return [{ poly: [[0, 0]], text: 模型, score: 0.9 }]; };
    vi.resetModules();
    路由 = await import("@/app/api/mobile/scan/route");
  });
  const 发 = (令牌: string | null, body: BodyInit | null = 图, lang = "中英") =>
    路由.POST(new Request(`http://x/api/mobile/scan?lang=${encodeURIComponent(lang)}`, { method: "POST", body, headers: 令牌 ? { authorization: `Bearer ${令牌}` } : {} }));
  const 行们 = async (r: Response) => (await r.text()).trim().split("\n").map((l) => JSON.parse(l));

  it("团队版：一行一行回排队位置，最后是框；换语言用对应的模型", async () => {
    const r = await 发("dk_team");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/x-ndjson");
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect(await 行们(r)).toEqual([{ 排队: 2 }, { 排队: 1 }, { 排队: 0 }, { 框: [{ poly: [[0, 0]], text: "PP-OCRv6_tiny", score: 0.9 }] }]);
    expect((await 行们(await 发("dk_team", 图, "韩"))).at(-1).框[0].text).toBe("korean_PP-OCRv5_mobile");
  });

  it("没排队就直接是框（不报 0）", async () => {
    假.认 = async (_图, _模型, o) => { o.进?.(0); return []; };
    expect(await 行们(await 发("dk_team"))).toEqual([{ 框: [] }]);
  });

  it("自部署 404、没令牌 / 令牌不对 401、个人版 403、不认识的语言 400", async () => {
    expect((await 发("dk_solo")).status).toBe(403);
    expect((await 发(null)).status).toBe(401);
    expect((await 发("dk_nope")).status).toBe(401);
    expect((await 发("dk_team", 图, "火星")).status).toBe(400);
    假.多租户 = false;
    expect((await 发("dk_team")).status).toBe(404);
    expect((await 路由.GET(new Request("http://x/api/mobile/scan", { headers: { authorization: "Bearer dk_team" } }))).status).toBe(404);
  });

  it("个人版刚开通团队：马上就能用（不是团队版的结果不缓存）", async () => {
    expect((await 发("dk_solo")).status).toBe(403);
    假.资格.set("acct_solo", "ok");
    expect((await 发("dk_solo")).status).toBe(200);
  });

  it("照片太大（> 2 MB）或空的：413，不交给识别", async () => {
    假.认 = async () => { throw new Error("不该认"); };
    expect((await 发("dk_team", new Uint8Array(2 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await 发("dk_team", new Uint8Array(0))).status).toBe(413);
  });

  it("按账号限次：10 分钟 90 遍，第 91 遍 429；别的账号不受影响", async () => {
    for (let i = 0; i < 90; i++) expect((await 发("dk_team")).status).toBe(200);
    expect((await 发("dk_team")).status).toBe(429);
    expect((await 发("dk_team2")).status).toBe(200);
  });

  it("太忙回 {忙:true}，别的错回 {错}（都不带照片内容）", async () => {
    const { 太忙: 忙 } = await import("@/lib/card-scan/server/pool");
    假.认 = async () => { throw new 忙("排队太久"); };
    expect(await 行们(await 发("dk_team"))).toEqual([{ 忙: true }]);
    假.认 = async () => { throw new Error("OpenCV 炸了 /secret/path"); };
    expect(await 行们(await 发("dk_team"))).toEqual([{ 错: "服务器没认出来" }]);
  });

  it("GET：团队版回 ok 并把线程起好", async () => {
    const r = await 路由.GET(new Request("http://x/api/mobile/scan", { headers: { authorization: "Bearer dk_team" } }));
    expect(await r.json()).toEqual({ ok: true });
    expect(假.预热).toBeGreaterThan(0);
  });
});

// ---------- 手机这头 ----------
describe("cloud.ts 服务器认", () => {
  let 云: typeof import("@/lib/card-scan/cloud");
  beforeEach(async () => {
    vi.resetModules();
    云 = await import("@/lib/card-scan/cloud");
    云.设识别令牌("dk_team");
  });
  const 流 = (行们: string[], 状态 = 200) =>
    vi.fn(async () => new Response(new ReadableStream({
      async start(c) {
        for (const l of 行们) { await new Promise((ok) => setTimeout(ok, 1)); c.enqueue(new TextEncoder().encode(l)); }
        c.close();
      },
    }), { status: 状态 })) as unknown as typeof fetch;
  const 图块 = new Blob([new Uint8Array(100)], { type: "image/jpeg" });

  it("读排队位置（行可能被拆开到两块里），最后拿到框；带令牌、按语言", async () => {
    const 抓 = 流(['{"排队":2}\n{"排', '队":1}\n', '{"排队":0}\n{"框":[{"poly":[],"text":"A","score":1}]}\n']);
    const 位置: number[] = [];
    const 项们 = await 云.服务器认(图块, "韩", (x) => 位置.push(x), { 抓 });
    expect(项们).toEqual([{ poly: [], text: "A", score: 1 }]);
    expect(位置).toEqual([2, 1, 0]);
    const [url, init] = (抓 as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`/api/mobile/scan?lang=${encodeURIComponent("韩")}`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer dk_team");
  });

  it("服务器说忙 / 429 / 500 / 读到一半断了 / 没给结果：抛 服务器不认（这次改本机认，下次还问服务器）", async () => {
    for (const [抓, 原因] of [
      [流(['{"忙":true}\n']), "忙"],
      [流([], 429), "忙"],
      [流([], 500), "坏"],
      [流(['{"排队":1}\n']), "坏"],
      [vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch, "断网"],
    ] as const) {
      const e = await 云.服务器认(图块, "中英", () => undefined, { 抓 }).catch((x) => x);
      expect(e).toBeInstanceOf(云.服务器不认);
      expect(e.原因).toBe(原因);
    }
    expect(云.能用服务器()).toBe(true);
  });

  it("不给用（404 自部署 / 401 / 403 个人版）：这次打开期间不再问", async () => {
    const e = await 云.服务器认(图块, "中英", () => undefined, { 抓: 流([], 404) }).catch((x) => x);
    expect(e.原因).toBe("没开");
    expect(云.能用服务器()).toBe(false);
    const 抓 = 流(['{"框":[]}\n']);
    await expect(云.服务器认(图块, "中英", () => undefined, { 抓 })).rejects.toBeInstanceOf(云.服务器不认);
    expect(抓).not.toHaveBeenCalled();
    // 换了账号（重新登录）再问
    云.设识别令牌("dk_other");
    expect(云.能用服务器()).toBe(true);
  });

  it("没登录：不问服务器", async () => {
    云.设识别令牌(null);
    expect(云.能用服务器()).toBe(false);
    expect(await 云.服务器预热(流([]))).toBe(false);
  });

  it("预热：团队版回 true；404 记下不给用", async () => {
    expect(await 云.服务器预热(vi.fn(async () => Response.json({ ok: true })) as unknown as typeof fetch)).toBe(true);
    expect(await 云.服务器预热(流([], 404))).toBe(false);
    expect(云.能用服务器()).toBe(false);
  });
});
