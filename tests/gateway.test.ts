import { closeTestDatabases } from "./close-databases";
/**
 * 模型网关与设备令牌。
 *
 * 这条路上每一次放行都在花我们自己的钱，所以要钉的全是"什么时候不放行"：
 * 没配网关、令牌不对、令牌被吊销、模型不在白名单、免费次数用完。
 * 再加一条正向的：放行时确实扣了一次、确实把收拾干净的请求体转给了上游。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-gw-${process.pid}`);
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
  await closeTestDatabases(临时根);
  fs.rmSync(临时根, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.GATEWAY_API_KEY = "upstream-key";
  process.env.GATEWAY_BASE_URL = 上游;
  process.env.GATEWAY_MODELS = "glm-5.3-flash|限时免费,deepseek-chat";
  const { resetAiQuota } = await import("@/lib/ai-quota");
  resetAiQuota();
  const { 重置限流 } = await import("@/lib/rate-limit");
  重置限流();
  vi.unstubAllGlobals();
});

let 序号 = 0;
/**
 * 建一个账号，并给它签一枚设备令牌。
 *
 * 默认**连注册赠送一起结掉**，等于"他在自己那台机器上登录过"——桌面端拿得到令牌
 * 就必然经过登录接口，那一步会结。2026-09-19 起注册赠送要一台机器发一次，
 * 只在登录接口上发得出来（credits.ts），所以这里得照着真实路径给它一个机器标识；
 * 不给的话这个账号上限只有每日那几次，下面所有按 30+3 算的用例都会跟着错。
 *
 * `没登录过: true` 是故意跳过那一步：用来验"拿不到机器信息的接口不该白送"。
 */
async function 建账号带令牌(opts: { 没登录过?: boolean } = {}) {
  const { createAccount } = await import("@/lib/tenant/accounts");
  const { 签发 } = await import("@/lib/tenant/device-token");
  const { 结算赠送 } = await import("@/lib/tenant/credits");
  const 第几个 = 序号++;
  const acc = await createAccount({
    target: { kind: "phone", value: `1380000${String(第几个).padStart(4, "0")}` },
    password: "abcd1234",
    name: "桌面用户",
  });
  const { token, id } = await 签发(acc.id, "我的 MacBook");
  // 一台机器一个账号，各自互不影响
  const 机器 = createHash("sha256").update(`网关测试机器:${第几个}`).digest("hex");
  if (!opts.没登录过) await 结算赠送({ kind: "account", id: acc.id }, 机器);
  return { acc, token, tokenId: id, 机器 };
}

function 请求(token: string | null, body: unknown, url = "https://app.example.com/api/gateway/v1/chat/completions") {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "x-forwarded-for": "203.0.113.7",
    },
    body: JSON.stringify(body),
  });
}

const 一次问话 = { model: "deepseek-chat", messages: [{ role: "user", content: "你好" }] };

describe("没配网关时这些路由不存在", () => {
  it("缺 GATEWAY_API_KEY → 404，而不是 401", async () => {
    delete process.env.GATEWAY_API_KEY;
    const { token } = await 建账号带令牌();
    const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
    expect((await POST(请求(token, 一次问话))).status).toBe(404);
  });
});

describe("令牌", () => {
  it("不带、乱填、格式不对都是 401", async () => {
    const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
    for (const t of [null, "abc", "Bearer", "dk_thisTokenDoesNotExist"]) {
      expect((await POST(请求(t, 一次问话))).status, `令牌 ${t} 不该放行`).toBe(401);
    }
  });

  it("库里只存 sha256，明文不落库", async () => {
    const { token } = await 建账号带令牌();
    const { control } = await import("@/lib/tenant/control");
    const rows = await control.deviceToken.findMany();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.tokenHash).not.toBe(token);
      expect(r.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("吊销之后立刻不认", async () => {
    const { token, tokenId, acc } = await 建账号带令牌();
    const { 认领, 吊销 } = await import("@/lib/tenant/device-token");
    expect(await 认领(token)).not.toBeNull();
    expect(await 吊销(tokenId, acc.id)).toBe(true);
    expect(await 认领(token)).toBeNull();
  });

  it("只能吊销自己的令牌——猜到 id 也踢不掉别人的机器", async () => {
    const 甲 = await 建账号带令牌();
    const 乙 = await 建账号带令牌();
    const { 吊销, 认领 } = await import("@/lib/tenant/device-token");
    expect(await 吊销(甲.tokenId, 乙.acc.id)).toBe(false);
    expect(await 认领(甲.token)).not.toBeNull();
  });
});

/**
 * 设置页「已登录的机器」那一栏的数据来源（settings/actions.ts 的 我的机器）。
 *
 * 这一栏 2026-09-17 才有。在那之前 `列出` 全仓引用次数是 0：改密码能一次吊光，
 * 而「只丢了备用本，不想让另外两台重登」没有任何路。
 */
describe("已登录的机器这一栏", () => {
  it("只列自己的机器——列表里出现别人的机器名，就等于能看也能踢", async () => {
    const { 签发, 列出 } = await import("@/lib/tenant/device-token");
    const 甲 = await 建账号带令牌();
    const 乙 = await 建账号带令牌();
    await 签发(乙.acc.id, "乙的台式机");

    const 甲的 = await 列出(甲.acc.id);
    expect(甲的.map((d) => d.name)).toEqual(["我的 MacBook"]);
    expect(甲的.map((d) => d.id)).not.toContain(乙.tokenId);
  });

  it("退出过的不再出现——否则按钮点完那一行还在，看起来像没生效", async () => {
    const { 签发, 吊销, 列出 } = await import("@/lib/tenant/device-token");
    const { acc } = await 建账号带令牌();
    const 备用本 = await 签发(acc.id, "备用本");
    expect((await 列出(acc.id))).toHaveLength(2);

    expect(await 吊销(备用本.id, acc.id)).toBe(true);
    const 剩下 = await 列出(acc.id);
    expect(剩下.map((d) => d.name), "只该退掉那一台，另一台照常用着").toEqual(["我的 MacBook"]);
    // 同一台再退一次要回 false，界面据此说「这台机器已经退出了」
    expect(await 吊销(备用本.id, acc.id)).toBe(false);
  });

  it("新登录的在最前面，还带上「最近调用 AI」那一列要的时间", async () => {
    const { 签发, 认领, 列出 } = await import("@/lib/tenant/device-token");
    const { acc, token } = await 建账号带令牌();
    await new Promise((r) => setTimeout(r, 5));
    await 签发(acc.id, "刚登的那台");

    const 列 = await 列出(acc.id);
    expect(列.map((d) => d.name)).toEqual(["刚登的那台", "我的 MacBook"]);
    // 登录了但一次 AI 都没用过是常态，那一列显示「还没有」，不是「从未使用」
    expect(列.every((d) => d.lastUsedAt === null)).toBe(true);
    await 认领(token);
    expect((await 列出(acc.id)).find((d) => d.id === 列[1].id)?.lastUsedAt).not.toBeNull();
  });
});

describe("请求体", () => {
  it("模型不在白名单就拒——不限的话一个改字段的请求就能把额度花在最贵的模型上", async () => {
    const { token } = await 建账号带令牌();
    const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
    const res = await POST(请求(token, { ...一次问话, model: "gpt-4o" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("不支持的模型");
  });

  it("messages 为空就拒", async () => {
    const { token } = await 建账号带令牌();
    const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
    expect((await POST(请求(token, { model: "deepseek-chat", messages: [] }))).status).toBe(400);
  });

  it("只透传认识的字段，max_tokens 夹到上限内", async () => {
    const { 收拾请求体, 读网关配置, 最大输出长度 } = await import("@/lib/gateway");
    const cfg = 读网关配置()!;
    const r = 收拾请求体(
      { model: "deepseek-chat", messages: [{ role: "user", content: "x" }], max_tokens: 999_999, temperature: 9, n: 10, user: "谁" },
      cfg,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.max_tokens).toBe(最大输出长度);
    expect(r.body.temperature).toBe(2);
    expect(r.body).not.toHaveProperty("n");
    expect(r.body).not.toHaveProperty("user");
  });

  it("不填 model 时用白名单里的第一个", async () => {
    const { 收拾请求体, 读网关配置 } = await import("@/lib/gateway");
    const r = 收拾请求体({ messages: [{ role: "user", content: "x" }] }, 读网关配置()!);
    expect(r.ok && r.body.model).toBe("glm-5.3-flash");
  });
});

describe("额度", () => {
  it("放行时扣一次，并把剩余次数写在响应头上", async () => {
    const { token, acc } = await 建账号带令牌();
    const 上游收到: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      上游收到.push({
        url: String(url),
        body: JSON.parse(String(init.body)),
        auth: new Headers(init.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: "好" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
    const res = await POST(请求(token, 一次问话));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ choices: [{ message: { content: "好" } }] });

    // 转给上游时换成我们自己的 Key，客户端的令牌不会外泄给上游
    expect(上游收到).toHaveLength(1);
    expect(上游收到[0].url).toBe(`${上游}/chat/completions`);
    expect(上游收到[0].auth).toBe("Bearer upstream-key");

    const { 余额 } = await import("@/lib/tenant/credits");
    const 余 = await 余额({ kind: "account", id: acc.id });
    expect(余.用掉).toBe(1);
    expect(res.headers.get("X-Credits-Remaining")).toBe(String(余.还剩));
  });

  it("免费次数用完就 402，且不再打上游——免费额度就是花钱的闸门", async () => {
    const { token, acc } = await 建账号带令牌();
    const { control } = await import("@/lib/tenant/control");
    const { resetAiQuota } = await import("@/lib/ai-quota");
    const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
    let 打了几次上游 = 0;
    vi.stubGlobal("fetch", async () => {
      打了几次上游++;
      return new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    // 一直问到被拦下为止。每轮清掉频率限流——那是另一码事（防失控脚本），
    // 这里要验的是"总共能免费问几次"
    let 放行 = 0;
    let res: Response;
    for (;;) {
      resetAiQuota();
      res = await POST(请求(token, 一次问话));
      if (res.status !== 200) break;
      放行++;
      if (放行 > 100) throw new Error("怎么问都不拦，闸门没起作用");
    }

    expect(res.status).toBe(402);
    expect((await res.json()).error.message).toContain("用完");
    // 注册送的加上当天那份每日赠送。每日赠送是懒发的：余额掉到门槛以下才发
    const { 注册赠送, 每日赠送 } = await import("@/lib/tenant/credits");
    expect(放行).toBe(注册赠送 + 每日赠送);
    expect(打了几次上游, "拦下的那次不该打上游").toBe(放行);

    // 拦下的那次要还回去，否则运营后来补的次数会被这些空计数吃掉
    const 用 = await control.accountAiUsage.findUnique({ where: { accountId: acc.id } });
    expect(用!.calls).toBe(放行);
  });

  /*
    2026-09-21 改口径：**我们这边的错要退，请求本身的错照旧算一次。**

    原来是「失败也算一次，限的是发起」，理由是「否则反复失败可以无限重试」。
    那条理由只对后半句成立：上游炸了、上游限我们、上游超时，用户什么都没拿到，
    让他买单说不过去——价格页卖的是「一次提问」，不是「一次发起」。
    而 4xx 那半句照旧：构造一个必定失败的请求如果能退，就是一条无限免费的路。
  */
  it("上游 5xx：退还——那不是用户的问题，他什么都没拿到", async () => {
    const { token, acc } = await 建账号带令牌();
    vi.stubGlobal("fetch", async () => new Response("上游炸了", { status: 500 }));
    const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
    const res = await POST(请求(token, 一次问话));
    expect(res.status).toBe(500);
    const { 余额 } = await import("@/lib/tenant/credits");
    expect((await 余额({ kind: "account", id: acc.id })).用掉).toBe(0);
  });

  it("上游 429（它在限我们）：也退", async () => {
    const { token, acc } = await 建账号带令牌();
    vi.stubGlobal("fetch", async () => new Response("slow down", { status: 429 }));
    const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
    await POST(请求(token, 一次问话));
    const { 余额 } = await import("@/lib/tenant/credits");
    expect((await 余额({ kind: "account", id: acc.id })).用掉).toBe(0);
  });

  it("上游 400（请求本身不对）：照旧算一次——不然构造一个必失败的请求就是无限免费", async () => {
    const { token, acc } = await 建账号带令牌();
    vi.stubGlobal("fetch", async () => new Response("bad request", { status: 400 }));
    const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
    await POST(请求(token, 一次问话));
    const { 余额 } = await import("@/lib/tenant/credits");
    expect((await 余额({ kind: "account", id: acc.id })).用掉).toBe(1);
  });

  it("连不上上游：退——和 5xx 同一个道理", async () => {
    const { token, acc } = await 建账号带令牌();
    vi.stubGlobal("fetch", async () => { throw new Error("connect ECONNREFUSED"); });
    const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
    const res = await POST(请求(token, 一次问话));
    expect(res.status).toBe(504);
    const { 余额 } = await import("@/lib/tenant/credits");
    expect((await 余额({ kind: "account", id: acc.id })).用掉).toBe(0);
  });

  it("**同一个问题的几步只扣一次**：带同一个 X-Question-Id 打三次", async () => {
    const { token, acc } = await 建账号带令牌();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
    for (let i = 0; i < 3; i++) {
      const req = 请求(token, 一次问话);
      req.headers.set("X-Question-Id", "q-same");
      req.headers.set("X-Feature", "ask");
      const res = await POST(req);
      expect(res.status).toBe(200);
    }
    const { 余额 } = await import("@/lib/tenant/credits");
    expect((await 余额({ kind: "account", id: acc.id })).用掉).toBe(1);
  });

  it("不带 X-Question-Id 的老客户端照旧每次扣", async () => {
    const { token, acc } = await 建账号带令牌();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
    for (let i = 0; i < 3; i++) await POST(请求(token, 一次问话));
    const { 余额 } = await import("@/lib/tenant/credits");
    expect((await 余额({ kind: "account", id: acc.id })).用掉).toBe(3);
  });

  it("两个账号各算各的", async () => {
    const 甲 = await 建账号带令牌();
    const 乙 = await 建账号带令牌();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
    for (let i = 0; i < 3; i++) await POST(请求(甲.token, 一次问话));
    const { 余额 } = await import("@/lib/tenant/credits");
    expect((await 余额({ kind: "account", id: 甲.acc.id })).用掉).toBe(3);
    expect((await 余额({ kind: "account", id: 乙.acc.id })).用掉).toBe(0);
  });
});

describe("模型列表与余额查询", () => {
  it("返回的是我们的白名单，不是上游的全量列表", async () => {
    const { token } = await 建账号带令牌();
    const { GET } = await import("@/app/api/gateway/v1/models/route");
    const res = await GET(请求(token, {}, "https://app.example.com/api/gateway/v1/models"));
    const data = await res.json();
    expect(data.data.map((m: { id: string }) => m.id)).toEqual(["glm-5.3-flash", "deepseek-chat"]);
    expect(data.data[0].note).toBe("限时免费");
  });

  it("余额接口要令牌", async () => {
    const { GET } = await import("@/app/api/gateway/v1/credits/route");
    expect((await GET(请求(null, {}, "https://app.example.com/api/gateway/v1/credits"))).status).toBe(401);
  });

  it("登录过的账号来查，看到的就是他账上那些", async () => {
    const { token } = await 建账号带令牌();
    const { GET } = await import("@/app/api/gateway/v1/credits/route");
    const res = await GET(请求(token, {}, "https://app.example.com/api/gateway/v1/credits"));
    const { 注册赠送 } = await import("@/lib/tenant/credits");
    expect((await res.json()).还剩).toBe(注册赠送);
  });

  it("这个接口不会凭空补注册赠送——它拿不到机器，补就是个后门", async () => {
    /*
      2026-09-19 改：注册赠送一台机器只发一次，而这个接口只认一枚令牌、
      不知道是哪台机器。原来它是顺手补注册赠送的——留着那一下，
      登录时被「这台电脑领过了」拦下的第二个账号，打开应用看一眼额度就补上了。
      详见 route.ts 里那段和 credits.ts 的文件头。更细的用例在 tests/machine-signup.test.ts。
    */
    const { token, acc } = await 建账号带令牌({ 没登录过: true });
    const { GET } = await import("@/app/api/gateway/v1/credits/route");
    const res = await GET(请求(token, {}, "https://app.example.com/api/gateway/v1/credits"));
    const { 每日赠送 } = await import("@/lib/tenant/credits");
    // 每日赠送照发：不知道是哪台机器不等于不让人用 AI
    expect((await res.json()).还剩).toBe(每日赠送);
    const { control } = await import("@/lib/tenant/control");
    expect(await control.accountAiGrant.count({ where: { accountId: acc.id, reason: "signup" } })).toBe(0);
  });
});

describe("发令牌的接口", () => {
  it("退出登录要把令牌吊销掉——只删本地文件的话它在库里还有效", async () => {
    const { token } = await 建账号带令牌();
    const { DELETE } = await import("@/app/api/account/token/route");
    const { 认领 } = await import("@/lib/tenant/device-token");
    expect(await 认领(token)).not.toBeNull();

    const 退 = await DELETE(new Request("https://app.example.com/api/account/token", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }));
    expect(退.status).toBe(200);
    expect(await 认领(token)).toBeNull();

    // 令牌本来就无效时也算退成功：退出登录不该因为这个失败
    expect((await DELETE(new Request("https://app.example.com/api/account/token", { method: "DELETE" }))).status).toBe(200);
  });


  it("密码对了发一枚令牌，密码错了 401 且不区分账号存不存在", async () => {
    const { createAccount } = await import("@/lib/tenant/accounts");
    await createAccount({ target: { kind: "phone", value: "13900001111" }, password: "abcd1234", name: "王" });
    const { POST } = await import("@/app/api/account/token/route");
    const 发 = (body: unknown) =>
      POST(new Request("https://app.example.com/api/account/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.8" },
        body: JSON.stringify(body),
      }));

    const 错 = await 发({ target: "13900001111", password: "错的密码" });
    expect(错.status).toBe(401);
    const 没这个号 = await 发({ target: "13900009999", password: "abcd1234" });
    expect(没这个号.status).toBe(401);
    expect(await 没这个号.json()).toEqual(await 错.clone().json());

    const 机器 = createHash("sha256").update("发令牌接口的那台机器").digest("hex");
    const 对 = await 发({ target: "13900001111", password: "abcd1234", name: "我的 Mac", machine: 机器 });
    expect(对.status).toBe(200);
    const data = await 对.json();
    expect(data.token).toMatch(/^dk_/);
    // 发完令牌就该看得到自己有多少次。注册赠送在这一步发，一台机器一次（见 machine-signup.test.ts）
    const { 注册赠送 } = await import("@/lib/tenant/credits");
    expect(data.credits.还剩).toBe(注册赠送);

    const { 认领 } = await import("@/lib/tenant/device-token");
    expect(await 认领(data.token)).not.toBeNull();
  });
});
