import { closeTestDatabases } from "./close-databases";
/**
 * 从桌面端打开运营台（lib/ops-auth.ts，2026-09-28）：只有运营名单里的那一个账号能进。
 * 这是一道门，两头都钉：该进的进得来（令牌 → 进门码 → 票 → 页面和动作都认），
 * 不该进的都进不来（名单外、令牌不对、码用第二次 / 过期、业务会话冒充、签票后被移出名单、没配名单）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";


const 根 = path.resolve(__dirname, "..");
const 临时根 = path.join(os.tmpdir(), `crm-ops-auth-${process.pid}`);

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
  await closeTestDatabases(临时根);
  fs.rmSync(临时根, { recursive: true, force: true });
});

beforeEach(async () => {
  const { control } = await import("@/lib/tenant/control");
  await control.machineSignup.deleteMany({});
  await control.accountAiGrant.deleteMany({});
  await control.accountAiUsage.deleteMany({});
  await control.aiGrant.deleteMany({});
  await control.aiUsage.deleteMany({});
  const { 重置限流 } = await import("@/lib/rate-limit");
  重置限流();
});



/** 这一次「请求」带着的 cookie。页面和动作的门都经 next/headers 读它 */
let 当前cookie: Record<string, string> = {};
// 动作成功后会 revalidatePath，单测里没有 Next 的缓存上下文（admin-guard 那组同样这么做）
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (k: string) => (k in 当前cookie ? { name: k, value: 当前cookie[k] } : undefined), set: () => {}, delete: () => {} }),
}));

let 序号 = 0;
async function 建账号(email: string) {
  const { createAccount } = await import("@/lib/tenant/accounts");
  return createAccount({ target: { kind: "email", value: email }, password: "abcd1234", name: `人${序号++}` });
}
async function 发令牌(accountId: string) {
  const { 签发 } = await import("@/lib/tenant/device-token");
  return (await 签发(accountId, "某台机器")).token;
}
const 带令牌 = (token: string, method = "GET") => new Request("https://app.example.com/x", { method, headers: { Authorization: `Bearer ${token}` } });

beforeEach(() => {
  当前cookie = {};
  process.env.OPS_ACCOUNTS = "boss@example.com";
  process.env.ADMIN_TOKEN = "admin-token-for-tests-0123";
});
afterEach(() => {
  delete process.env.OPS_ACCOUNTS;
  delete process.env.ADMIN_TOKEN;
});

describe("运营名单", () => {
  it("逗号、分号、空格都能分，大小写不算", async () => {
    const { 运营名单 } = await import("@/lib/ops-auth");
    expect(运营名单({ OPS_ACCOUNTS: " Boss@Example.com ; 13800001111,  x@y.z " })).toEqual(["boss@example.com", "13800001111", "x@y.z"]);
    expect(运营名单({})).toEqual([]);
  });
});

describe("进门码：一次性、60 秒", () => {
  it("用一次就作废", async () => {
    const { 发进门码, 用进门码 } = await import("@/lib/ops-auth");
    const c = 发进门码("acc-1");
    expect(用进门码(c)).toBe("acc-1");
    expect(用进门码(c)).toBeNull();
  });
  it("过了 60 秒不认；乱填的不认", async () => {
    const { 发进门码, 用进门码 } = await import("@/lib/ops-auth");
    const 早 = Date.now();
    const c = 发进门码("acc-2", 早);
    expect(用进门码(c, 早 + 61_000)).toBeNull();
    expect(用进门码("乱填的")).toBeNull();
    expect(用进门码(null)).toBeNull();
  });
});

describe("从桌面端进运营台：只有名单里那一个账号", () => {
  it("没配名单：两个接口都 404，当这条路不存在", async () => {
    delete process.env.OPS_ACCOUNTS;
    const boss = await 建账号("boss-nolist@example.com");
    const t = await 发令牌(boss.id);
    expect((await (await import("@/app/api/ops/can/route")).GET(带令牌(t))).status).toBe(404);
    expect((await (await import("@/app/api/ops/enter/route")).POST(带令牌(t, "POST"))).status).toBe(404);
  });

  it("名单外的人：能问，答案是不能；换进门码 403", async () => {
    const 路人 = await 建账号("someone@example.com");
    const t = await 发令牌(路人.id);
    expect(await (await (await import("@/app/api/ops/can/route")).GET(带令牌(t))).json()).toEqual({ ok: false });
    expect((await (await import("@/app/api/ops/enter/route")).POST(带令牌(t, "POST"))).status).toBe(403);
  });

  it("令牌不对 401", async () => {
    expect((await (await import("@/app/api/ops/can/route")).GET(带令牌("dt_wrong_token_for_tests"))).status).toBe(401);
  });

  it("名单里的人：进门码 → 12 小时的票（只挂在 /admin 下、httpOnly）→ 运营台认它；码第二次用就 404", async () => {
    const boss = await 建账号("boss@example.com");
    const t = await 发令牌(boss.id);
    expect(await (await (await import("@/app/api/ops/can/route")).GET(带令牌(t))).json()).toEqual({ ok: true });

    const r = await (await import("@/app/api/ops/enter/route")).POST(带令牌(t, "POST"));
    const { path: 路径 } = (await r.json()) as { path: string };
    expect(路径).toMatch(/^\/admin\/enter\?code=[0-9a-f]{48}$/);

    const { GET: 进门 } = await import("@/app/admin/enter/route");
    const res = await 进门(new Request(`https://app.example.com${路径}`));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin");
    const 票头 = res.headers.get("set-cookie") ?? "";
    expect(票头).toMatch(/crm_ops=/);
    expect(票头).toMatch(/HttpOnly/i);
    expect(票头).toMatch(/Path=\/admin/);

    expect((await 进门(new Request(`https://app.example.com${路径}`))).status, "同一枚码第二次").toBe(404);

    // 带着这张票：页面的门放行（返回空口令 = 链接里不带 ?token=）、动作也放行
    当前cookie = { crm_ops: 票头.match(/crm_ops=([^;]+)/)![1] };
    const { 验口令 } = await import("@/app/admin/guard");
    await expect(验口令(Promise.resolve({}))).resolves.toBe("");
    const { 标记反馈 } = await import("@/app/admin/actions");
    const { control } = await import("@/lib/tenant/control");
    const f = await control.feedback.create({ data: { body: "测一下", source: "desktop" } });
    expect((await 标记反馈({ token: "", id: f.id, handled: true })).ok).toBe(true);
  });

  it("票签出去之后把他移出名单：下一次点击就进不去，不用等 12 小时", async () => {
    const boss = await 建账号("boss2@example.com");
    process.env.OPS_ACCOUNTS = "boss2@example.com";
    const { 签运营票, 认运营票 } = await import("@/lib/ops-auth");
    const 票 = await 签运营票(boss.id);
    expect(await 认运营票(票)).toBe(boss.id);
    process.env.OPS_ACCOUNTS = "someone-else@example.com";
    expect(await 认运营票(票)).toBeNull();
  });

  it("业务登录的会话票不能冒充运营台票（同一把密钥，用途不同）", async () => {
    const boss = await 建账号("boss3@example.com");
    process.env.OPS_ACCOUNTS = "boss3@example.com";
    const { SignJWT } = await import("jose");
    const { SECRET } = await import("@/lib/auth");
    const 业务票 = await new SignJWT({ sub: boss.id }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("7d").sign(SECRET);
    const { 认运营票 } = await import("@/lib/ops-auth");
    expect(await 认运营票(业务票)).toBeNull();
  });

  it("没口令、没票：页面 404，动作「无权操作」", async () => {
    const { 验口令 } = await import("@/app/admin/guard");
    await expect(验口令(Promise.resolve({}))).rejects.toThrow();
    await expect(验口令(Promise.resolve({ token: "猜的" }))).rejects.toThrow();
    const { 标记反馈 } = await import("@/app/admin/actions");
    expect(await 标记反馈({ token: "", id: "x", handled: true })).toEqual({ ok: false, error: "无权操作" });
  });
});
