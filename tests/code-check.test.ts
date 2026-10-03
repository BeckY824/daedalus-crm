import { closeTestDatabases } from "./close-databases";
/**
 * 输码填满先核对（2026-10-03 走查：错码要设完密码、点了注册才说）：/api/account/code/check 与 checkCode。
 * 只核对不用掉；错的照样算一次——这个口子不能变成不计次的猜码器（第六轮 A1）；对了不占名额。
 * 搭库照抄 tests/r6-review-signup.test.ts。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-codecheck-${process.pid}`);

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

beforeEach(async () => {
  const { 重置限流, 重置注册计数 } = await import("@/lib/rate-limit");
  重置限流();
  重置注册计数();
});

afterEach(() => {
  delete process.env.SIGNUP_REDIRECT;
  delete process.env.SIGNUP_VERIFY;
});

afterAll(async () => {
  delete process.env.MULTI_TENANT;
  await closeTestDatabases(临时根);
  fs.rmSync(临时根, { recursive: true, force: true });
});

let n = 0;
const 新邮箱 = () => `cc${n++}@example.com`;

function 发(body: unknown, 路径: string, ip = "203.0.113.61") {
  return new Request(`https://app.example.com/api/account/${路径}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}


async function 核对(body: unknown, ip?: string) {
  const { POST } = await import("@/app/api/account/code/check/route");
  const res = await POST(发(body, "code/check", ip));
  return { status: res.status, data: (await res.json()) as { ok?: boolean; error?: string } };
}

async function 造码(邮箱: string, purpose: "signup" | "reset") {
  const { issueCode } = await import("@/lib/tenant/accounts");
  const r = await issueCode(邮箱, purpose);
  if (!r.ok) throw new Error(r.error);
  return r.code;
}

const 错码 = (对的: string) => (对的 === "000000" ? "111111" : "000000");

async function 次数(邮箱: string) {
  const { control } = await import("@/lib/tenant/control");
  return (await control.verifyCode.findFirst({ where: { target: 邮箱 }, orderBy: { createdAt: "desc" } }))!.attempts;
}

describe("输码填满先核对：/api/account/code/check", () => {
  it("码对：回 ok，不占名额、不作废——后面真正用的那一下照样通过", async () => {
    const { consumeCode } = await import("@/lib/tenant/accounts");
    const 邮箱 = 新邮箱();
    const 码 = await 造码(邮箱, "signup");
    const r = await 核对({ target: 邮箱, code: 码, purpose: "signup" });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(await 次数(邮箱), "对的那次要把名额还回去").toBe(0);
    expect((await consumeCode(邮箱, 码, "signup")).ok).toBe(true);
  });

  it("码错：回 400「验证码不对」，并且算一次", async () => {
    const 邮箱 = 新邮箱();
    const 码 = await 造码(邮箱, "reset");
    const r = await 核对({ target: 邮箱, code: 错码(码), purpose: "reset" });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain("验证码不对");
    expect(await 次数(邮箱)).toBe(1);
  });

  it("不是不计次的猜码器：错 5 次以后，连对的码也核对不过、也用不掉", async () => {
    const { consumeCode } = await import("@/lib/tenant/accounts");
    const 邮箱 = 新邮箱();
    const 码 = await 造码(邮箱, "signup");
    for (let i = 0; i < 5; i++) await 核对({ target: 邮箱, code: 错码(码), purpose: "signup" }, `198.51.100.${i}`);
    const r = await 核对({ target: 邮箱, code: 码, purpose: "signup" }, "198.51.100.99");
    expect(r.status).toBe(400);
    expect(r.data.error).toContain("尝试次数过多");
    expect((await consumeCode(邮箱, 码, "signup")).ok).toBe(false);
  });

  it("并发猜：200 个错码夹一个对码一起打，真比对的不超过 5 次", async () => {
    const 邮箱 = 新邮箱();
    const 码 = await 造码(邮箱, "reset");
    const 一批 = Array.from({ length: 200 }, (_, i) => 核对({ target: 邮箱, code: i === 100 ? 码 : 错码(码), purpose: "reset" }, `192.0.2.${i % 250}`));
    const 结果 = await Promise.all(一批);
    const 比对过 = 结果.filter((r) => r.data.ok || /验证码不对/.test(r.data.error ?? "")).length;
    expect(比对过).toBeLessThanOrEqual(5);
    expect(await 次数(邮箱)).toBeLessThanOrEqual(5);
  });

  it("注册的码和找回密码的码不串用", async () => {
    const 邮箱 = 新邮箱();
    const 码 = await 造码(邮箱, "signup");
    const r = await 核对({ target: 邮箱, code: 码, purpose: "reset" });
    expect(r.status).toBe(400);
  });

  it("类型不对的请求回 400，不是 500", async () => {
    for (const body of [{ target: 123, code: "1", purpose: "signup" }, { target: "a@b.com", code: ["1"], purpose: "signup" }, { target: "a@b.com", code: "1", purpose: "login" }, null, []]) {
      expect((await 核对(body)).status).toBe(400);
    }
  });

  it("同一个 IP 一直错，进冷却", async () => {
    const 邮箱 = 新邮箱();
    await 造码(邮箱, "signup");
    let 最后 = "";
    for (let i = 0; i < 40; i++) 最后 = (await 核对({ target: 邮箱, code: "000001", purpose: "signup" }, "203.0.113.200")).data.error ?? "";
    expect(最后).toContain("操作太频繁");
  });
});
