/**
 * 模型成本账（AiCall）。
 *
 * 这张表存在的唯一理由是**攒一条真实的成本曲线**——「¥29 / 300 次」现在是照公开价估的，
 * 而我们走中转站，公开价不是实付价。数据只能随时间攒、补不回来。
 *
 * 所以这里钉的全是「坏了也不报错、只会让那条曲线悄悄失真」的事：
 *   上游没回 usage 时记成 0（一堆 0 会把平均值稀释，而稀释过的曲线比没有更坏——它看着是对的）
 *   自部署 / 桌面端本地模式也往里记（那是人家的 key，混进来合计就虚高）
 *   存量库补不上这张表（线上一条都记不到，而界面不会有任何异样）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 根 = path.resolve(__dirname, "..");
const 临时根 = path.join(os.tmpdir(), `crm-aicost-${process.pid}`);

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
  delete process.env.LLM_PRICE_IN;
  delete process.env.LLM_PRICE_OUT;
  fs.rmSync(临时根, { recursive: true, force: true });
});

beforeEach(async () => {
  const { control } = await import("@/lib/tenant/control");
  await control.aiCall.deleteMany();
});

describe("读用量：取不到就是 null，不是 0", () => {
  it("正常响应取得出来", async () => {
    const { 读用量 } = await import("@/lib/tenant/ai-cost");
    expect(读用量({ usage: { prompt_tokens: 1200, completion_tokens: 300 } })).toEqual({ input: 1200, output: 300 });
  });

  it("上游没回 usage → null。**宁可不记，也不要记 0**", async () => {
    const { 读用量 } = await import("@/lib/tenant/ai-cost");
    for (const 坏 of [null, undefined, {}, { usage: null }, { usage: {} }, { usage: { completion_tokens: 5 } }, "不是对象"]) {
      expect(读用量(坏), `${JSON.stringify(坏)} 不该被当成 0`).toBeNull();
    }
  });

  it("只缺 completion_tokens 时按 0 算——入是有的，这一行仍然有价值", async () => {
    const { 读用量 } = await import("@/lib/tenant/ai-cost");
    expect(读用量({ usage: { prompt_tokens: 900 } })).toEqual({ input: 900, output: 0 });
  });
});

describe("记一次", () => {
  it("落一行，字段照原样", async () => {
    const { 记一次 } = await import("@/lib/tenant/ai-cost");
    const { control } = await import("@/lib/tenant/control");
    await 记一次({ kind: "account", id: "acc_1" }, { model: "deepseek-v4-flash", usage: { input: 100, output: 20 }, feature: "ask" });
    const rows = await control.aiCall.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerKind: "account", ownerId: "acc_1", model: "deepseek-v4-flash", inputTokens: 100, outputTokens: 20, feature: "ask" });
  });

  it("**永不抛**——记账失败不该让用户的提问跟着失败", async () => {
    const { 记一次 } = await import("@/lib/tenant/ai-cost");
    // ownerId 给一个超长串只是随便找个会让写入出问题的输入；重点是它不往外抛
    await expect(记一次({ kind: "account", id: "x".repeat(5_000_000) }, { model: "m", usage: { input: 1, output: 1 } })).resolves.toBeUndefined();
  });
});

describe("记托管版一次：只有托管版才记", async () => {
  it("MULTI_TENANT 不是 1（自部署 / 桌面端本地模式）时一行都不写", async () => {
    const { 记托管版一次 } = await import("@/lib/tenant/ai-cost");
    const { control } = await import("@/lib/tenant/control");
    const 原 = process.env.MULTI_TENANT;
    process.env.MULTI_TENANT = "";
    try {
      记托管版一次({ usage: { prompt_tokens: 10, completion_tokens: 2 } }, "m", "ask");
      await new Promise((r) => setTimeout(r, 50));
      expect(await control.aiCall.count(), "自部署的 key 花的不是我们的钱，混进来合计就虚高").toBe(0);
    } finally {
      process.env.MULTI_TENANT = 原;
    }
  });
});

describe("成本概览", () => {
  it("按天 / 按模型 / 按归属都聚得对，合计对得上", async () => {
    const { 记一次, 成本概览 } = await import("@/lib/tenant/ai-cost");
    await 记一次({ kind: "account", id: "a1" }, { model: "m1", usage: { input: 100, output: 10 } });
    await 记一次({ kind: "account", id: "a1" }, { model: "m1", usage: { input: 200, output: 20 } });
    await 记一次({ kind: "workspace", id: "w1" }, { model: "m2", usage: { input: 50, output: 5 } });

    const c = await 成本概览(14);
    expect(c.合计).toEqual({ 次数: 3, 入: 350, 出: 35 });
    expect(c.按模型.map((m) => [m.model, m.次数, m.入])).toEqual([["m1", 2, 300], ["m2", 1, 50]]);
    const a1 = c.按归属.find((o) => o.id === "a1");
    expect(a1).toMatchObject({ kind: "account", 次数: 2, 入: 300, 出: 30 });
    // 三条都是刚写的，按本地日历天落在同一天
    expect(c.按天).toHaveLength(1);
    expect(c.按天[0]).toMatchObject({ 次数: 3, 入: 350, 出: 35 });
  });

  it("没配单价时不报价——先拍一个估值再拿它算，等于把猜测洗成「数据」", async () => {
    const { 成本概览 } = await import("@/lib/tenant/ai-cost");
    delete process.env.LLM_PRICE_IN;
    delete process.env.LLM_PRICE_OUT;
    expect((await 成本概览()).单价).toBeNull();
    process.env.LLM_PRICE_IN = "1.5";
    process.env.LLM_PRICE_OUT = "3";
    expect((await 成本概览()).单价).toEqual({ 入: 1.5, 出: 3 });
  });
});

describe("存量库补得上这张表", () => {
  it("control-migrations/ 里建了 AiCall 和它的索引", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const 目录 = path.join(根, "control-migrations");
    const 文件 = fs.readdirSync(目录).filter((f) => f.endsWith(".sql")).sort();
    const 库 = path.join(临时根, "_migrate-check.db");
    fs.rmSync(库, { force: true });
    const db = new DatabaseSync(库);
    try {
      for (const f of 文件) db.exec(fs.readFileSync(path.join(目录, f), "utf8"));
      const 表 = (db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((t) => t.name);
      expect(表, "存量库补不上这张表，线上一条都记不到，而界面不会有任何异样").toContain("AiCall");
      const 索引 = (db.prepare("select name from sqlite_master where type='index'").all() as { name: string }[]).map((t) => t.name);
      expect(索引).toContain("AiCall_at_idx");
    } finally {
      db.close();
      fs.rmSync(库, { force: true });
    }
  });

  it("control.prisma 和迁移文件两边都得有——漏一边就是一种部署上像没写一样", () => {
    expect(fs.readFileSync(path.join(根, "prisma/control.prisma"), "utf8")).toContain("model AiCall");
    expect(fs.existsSync(path.join(根, "control-migrations/011-ai-call.sql"))).toBe(true);
  });
});

/**
 * 桌面端那条路。**它的 token 只有经过网关才看得见**——桌面端的 llm.ts 跑在用户
 * 自己机器上，连不到控制面库。这条断了，内测期间桌面端烧的每一分钱都是黑的。
 */
describe("网关放行时把 token 记进成本账", () => {
  async function 建账号带令牌() {
    const { createAccount } = await import("@/lib/tenant/accounts");
    const { 签发 } = await import("@/lib/tenant/device-token");
    const { 结算赠送 } = await import("@/lib/tenant/credits");
    const n = Math.floor(Math.random() * 9000) + 1000;
    const acc = await createAccount({ target: { kind: "phone", value: `137${String(n).padStart(8, "0")}` }, password: "abcd1234", name: "桌面用户" });
    const { token } = await 签发(acc.id, "我的 MacBook");
    await 结算赠送({ kind: "account", id: acc.id }, createHash("sha256").update(`成本账测试:${n}`).digest("hex"));
    return { acc, token };
  }

  function 请求(token: string, body: unknown) {
    return new Request("https://app.example.com/api/gateway/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    process.env.GATEWAY_API_KEY = "upstream-key";
    process.env.GATEWAY_BASE_URL = "https://relay.example.com/v1";
    process.env.GATEWAY_MODELS = "glm-5.3-flash|限时免费,deepseek-chat";
    vi.unstubAllGlobals();
  });

  it("非流式：落一行，owner 是账号、模型是真正发给上游的那个", async () => {
    const { token, acc } = await 建账号带令牌();
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "好" } }], usage: { prompt_tokens: 1234, completion_tokens: 56 } }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }));
    const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
    const res = await POST(请求(token, { model: "deepseek-chat", messages: [{ role: "user", content: "你好" }] }));
    expect(res.status).toBe(200);

    const { control } = await import("@/lib/tenant/control");
    const rows = await control.aiCall.findMany({ where: { ownerId: acc.id } });
    expect(rows, "桌面端的 token 只有这条路看得见，记不上就是全黑").toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerKind: "account", model: "deepseek-chat", inputTokens: 1234, outputTokens: 56 });
  });

  it("上游没回 usage 时不记——别用 0 把曲线稀释了", async () => {
    const { token, acc } = await 建账号带令牌();
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "好" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
    expect((await POST(请求(token, { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] }))).status).toBe(200);
    const { control } = await import("@/lib/tenant/control");
    expect(await control.aiCall.count({ where: { ownerId: acc.id } })).toBe(0);
  });

  it("记账挡不住回答：就算写库失败，200 和正文照样回去", async () => {
    const { token } = await 建账号带令牌();
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "好" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }));
    const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
    const res = await POST(请求(token, { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).choices[0].message.content).toBe("好");
  });
});
