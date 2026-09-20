/**
 * 判断类模型的网关（桌面端专用那条）。
 *
 * 和隔壁 tests/gateway.test.ts 钉的东西不一样：那条路每放行一次都在花钱，所以钉"什么时候不放行"；
 * 这条路一次两万分之一美分，真正要钉的是**它和那本账簿的关系**——
 *
 *   **放行不扣免费次数。** 这是隐私政策第三节和产品那条线（判断类可以自动跑）的实现依据：
 *   判断类是自动跑的，记进 30 次账本就等于把用户的额度花在他看不见的地方。
 *   这一条破了不会报错，只会有人某天发现"我什么都没点，次数没了"。
 *
 * 另外两条也只在用户机器上才炸：model 必须由我们覆盖（否则客户端能指定我们的账单），
 * 上游报错时我们的 key 不能被回显出去（那把 key 是我们的）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-jevgw-${process.pid}`);

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  process.env.MULTI_TENANT = "1";
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时根, "control.db")}`;
  const sql = execFileSync(
    "npx",
    ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"],
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

afterAll(() => {
  delete process.env.MULTI_TENANT;
  delete process.env.JEV_API_KEY;
  delete process.env.JEV_BASE_URL;
  fs.rmSync(临时根, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.JEV_API_KEY = "our-jev-key-abcdefgh";
  process.env.JEV_BASE_URL = "https://jev.example.com";
  const { resetAiQuota } = await import("@/lib/ai-quota");
  resetAiQuota();
  vi.unstubAllGlobals();
});

let 序号 = 0;
async function 建账号带令牌() {
  const { createAccount } = await import("@/lib/tenant/accounts");
  const { 签发 } = await import("@/lib/tenant/device-token");
  const { 结算赠送 } = await import("@/lib/tenant/credits");
  const 第几个 = 序号++;
  const acc = await createAccount({
    target: { kind: "phone", value: `1390000${String(第几个).padStart(4, "0")}` },
    password: "abcd1234",
    name: "桌面用户",
  });
  const { token, id } = await 签发(acc.id, "我的 MacBook");
  const 机器 = createHash("sha256").update(`jev 网关测试机器:${第几个}`).digest("hex");
  await 结算赠送({ kind: "account", id: acc.id }, 机器);
  return { acc, token, tokenId: id };
}

const 一次判断 = {
  state: { 任务: "把一份客户表格的每一列对应到 CRM 里的字段" },
  questions: { c0: { type: "choice", instructions: "这一列是什么", criteria: { name: "姓名", _skip: "不导入" } } },
};

function 请求(token: string | null, body: unknown) {
  return new Request("https://app.example.com/api/gateway/v1/systemone", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function 假上游(收: { url: string; body: Record<string, unknown>; auth: string | null }[]) {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    收.push({ url: String(url), body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { c0: { type: "choice", choice: "name", confidence: 0.9, probabilities: {} } }, usage: { input_tokens: 100, output_tokens: 10 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

describe("门口", () => {
  it("没配 JEV_API_KEY → 404，当这条路不存在（而不是 401）", async () => {
    /*
      **先建账号再删环境变量**，顺序反了这条用例会假绿（实测是 504）：
      建账号会实例化控制面的 Prisma 客户端，而 Prisma 启动时会把 .env 重新读进
      process.env——本机 .env 里有 JEV_API_KEY，于是刚删掉的那一个又回来了。
    */
    const { token } = await 建账号带令牌();
    delete process.env.JEV_API_KEY;
    const { POST } = await import("@/app/api/gateway/v1/systemone/route");
    expect((await POST(请求(token, 一次判断))).status).toBe(404);
  });

  it("不带、乱填、格式不对的令牌都是 401", async () => {
    const { POST } = await import("@/app/api/gateway/v1/systemone/route");
    for (const t of [null, "abc", "Bearer", "dk_thisTokenDoesNotExist"]) {
      expect((await POST(请求(t, 一次判断))).status, `令牌 ${t} 不该放行`).toBe(401);
    }
  });

  it("令牌吊销之后立刻不认", async () => {
    const { token, tokenId, acc } = await 建账号带令牌();
    const { 吊销 } = await import("@/lib/tenant/device-token");
    const { POST } = await import("@/app/api/gateway/v1/systemone/route");
    假上游([]);
    expect((await POST(请求(token, 一次判断))).status).toBe(200);
    await 吊销(tokenId, acc.id);
    expect((await POST(请求(token, 一次判断))).status).toBe(401);
  });

  it("缺 questions 是 400，不往上游打", async () => {
    const { token } = await 建账号带令牌();
    const 收: Parameters<typeof 假上游>[0] = [];
    假上游(收);
    const { POST } = await import("@/app/api/gateway/v1/systemone/route");
    expect((await POST(请求(token, { state: "x" }))).status).toBe(400);
    expect(收).toHaveLength(0);
  });

  it("正文超上限是 413，也不往上游打——限流挡循环脚本，封顶挡「一次塞一本书」", async () => {
    const { token } = await 建账号带令牌();
    const 收: Parameters<typeof 假上游>[0] = [];
    假上游(收);
    const { POST } = await import("@/app/api/gateway/v1/systemone/route");
    const 巨大 = JSON.stringify({ ...一次判断, state: "填".repeat(300 * 1024) });
    expect((await POST(请求(token, 巨大))).status).toBe(413);
    expect(收).toHaveLength(0);
  });
});

describe("放行之后", () => {
  it("带我们的 key 打到上游，**model 由我们覆盖**——客户端能选模型就等于能选我们的账单", async () => {
    const { token } = await 建账号带令牌();
    const 收: Parameters<typeof 假上游>[0] = [];
    假上游(收);
    const { POST } = await import("@/app/api/gateway/v1/systemone/route");
    const res = await POST(请求(token, { ...一次判断, model: "某个贵得要命的模型" }));
    expect(res.status).toBe(200);
    expect(收).toHaveLength(1);
    expect(收[0].url).toBe("https://jev.example.com/v1/systemone");
    expect(收[0].auth).toBe("Bearer our-jev-key-abcdefgh");
    expect(收[0].body.model).toBe("jev-latest");
    expect(收[0].body.questions).toBeTruthy();
  });

  it("**不扣免费次数**。判断类是自动跑的，记进那本账就是把额度花在用户看不见的地方", async () => {
    const { token, acc } = await 建账号带令牌();
    const { 余额 } = await import("@/lib/tenant/credits");
    const 之前 = await 余额({ kind: "account", id: acc.id });
    假上游([]);
    const { POST } = await import("@/app/api/gateway/v1/systemone/route");
    for (let i = 0; i < 3; i++) expect((await POST(请求(token, 一次判断))).status).toBe(200);
    const 之后 = await 余额({ kind: "account", id: acc.id });
    expect(之后.用掉).toBe(之前.用掉);
    expect(之后.还剩).toBe(之前.还剩);
  });

  it("上游报错时，我们的 key 不能被回显出去", async () => {
    const { token } = await 建账号带令牌();
    vi.stubGlobal("fetch", async () => new Response("bad key: our-jev-key-abcdefgh", { status: 401 }));
    const { POST } = await import("@/app/api/gateway/v1/systemone/route");
    const res = await POST(请求(token, 一次判断));
    expect(res.status).toBe(401);
    const 文 = await res.text();
    expect(文).not.toContain("our-jev-key-abcdefgh");
    expect(文).toContain("****");
  });

  it("打太频繁会被拦成 429", async () => {
    const { token } = await 建账号带令牌();
    假上游([]);
    const { POST } = await import("@/app/api/gateway/v1/systemone/route");
    let 放行 = 0;
    let res: Response;
    for (;;) {
      res = await POST(请求(token, 一次判断));
      if (res.status !== 200) break;
      放行++;
      if (放行 > 200) throw new Error("一直没被拦下来");
    }
    expect(res.status).toBe(429);
    expect(放行).toBeGreaterThan(0);
  });
});
