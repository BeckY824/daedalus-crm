/**
 * 桌面端用的那三个账号接口：policy / code / password。
 *
 * （没有 register：注册整个在网页上办。试过在桌面端里直接开「只有账号没有工作区」的号，
 * 结果那种账号进不了网页版，而同一个邮箱又注册不了第二次。）
 *
 * 规则本身在 lib 里、也有单测（password-reset），这里钉的是 **HTTP 边界**：
 * 没有账号体系时是不是 404、失败是不是 400 而不是 500、
 * 以及「不能拿发码接口查号」在响应体上真的成立。
 *
 * 最后一条只有在这一层才看得出来：lib 那层两边都返回 { ok: true }，
 * 但只要接口把 hint 之类的东西漏出去，注册过和没注册过的响应就不一样了。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-acc-api-${process.pid}`);

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

beforeEach(async () => {
  const { 重置限流, 重置注册计数 } = await import("@/lib/rate-limit");
  重置限流();
  重置注册计数();
});

afterEach(() => {
  delete process.env.SIGNUP_REDIRECT;
  delete process.env.SIGNUP_VERIFY;
  delete process.env.SMS_ACCESS_KEY_ID;
  delete process.env.SMS_ACCESS_KEY_SECRET;
  delete process.env.SMS_SIGN_NAME;
  delete process.env.SMS_TEMPLATE_CODE;
});

afterAll(() => {
  delete process.env.MULTI_TENANT;
  fs.rmSync(临时根, { recursive: true, force: true });
});

let n = 0;
const 新邮箱 = () => `api${n++}@example.com`;

function 发(body: unknown, 路径: string, ip = "203.0.113.31") {
  return new Request(`https://app.example.com/api/account/${路径}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

/**
 * 开发环境默认把验证码回显在响应里（省得翻日志）。要验「注册过和没注册过响应一样」，
 * 得先把回显关掉——配上短信那四个变量就够：codeVisibleToClient() 看的是
 * 「一条通道都没配」，而邮件仍然没配，所以码还是只打进日志，不会真去连谁。
 */
function 关掉验证码回显() {
  process.env.SMS_ACCESS_KEY_ID = "x";
  process.env.SMS_ACCESS_KEY_SECRET = "x";
  process.env.SMS_SIGN_NAME = "x";
  process.env.SMS_TEMPLATE_CODE = "x";
}

describe("policy", () => {
  it("如实报出两个开关", async () => {
    const { GET } = await import("@/app/api/account/policy/route");
    const 默认 = await (await GET()).json();
    expect(默认).toEqual({ register: true, reset: true });

    // register 回答的是「网页那边还收不收新注册」——桌面端那个链接是开浏览器过去的
    process.env.SIGNUP_REDIRECT = "https://ai-daedalus.com/demo.html";
    expect((await (await GET()).json()).register).toBe(false);
  });

  it("没有账号体系的部署一律 404，而不是回一个全 false 的对象", async () => {
    /** 回 200 的话，桌面端会以为「连上了，只是都关着」，而实际上它连错了地方 */
    const { GET } = await import("@/app/api/account/policy/route");
    delete process.env.MULTI_TENANT;
    try {
      expect((await GET()).status).toBe(404);
    } finally {
      process.env.MULTI_TENANT = "1";
    }
  });
});

describe("code 与 password", () => {
  it("找回密码的发码接口：注册过和没注册过，响应一模一样", async () => {
    关掉验证码回显();
    const { POST } = await import("@/app/api/account/code/route");
    const { createAccount } = await import("@/lib/tenant/accounts");
    const 有号 = 新邮箱();
    await createAccount({ target: { kind: "email", value: 有号 }, password: "abcd1234", name: "某人" });

    const a = await POST(发({ target: 有号 }, "code"));
    const b = await POST(发({ target: 新邮箱() }, "code", "203.0.113.32"));
    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
  });

  it("走一遍改密码：错码 400、对码 200，之后只有新密码换得到令牌", async () => {
    const code路由 = await import("@/app/api/account/code/route");
    const pw路由 = await import("@/app/api/account/password/route");
    const token路由 = await import("@/app/api/account/token/route");
    const { control } = await import("@/lib/tenant/control");
    const { createAccount } = await import("@/lib/tenant/accounts");
    const 邮箱 = 新邮箱();
    await createAccount({ target: { kind: "email", value: 邮箱 }, password: "old12345", name: "某人" });

    expect((await code路由.POST(发({ target: 邮箱 }, "code"))).status).toBe(200);
    const row = await control.verifyCode.findFirst({
      where: { target: 邮箱, purpose: "reset", usedAt: null },
      orderBy: { createdAt: "desc" },
    });

    expect((await pw路由.POST(发({ target: 邮箱, code: "000000", password: "new12345" }, "password"))).status).toBe(400);
    expect((await pw路由.POST(发({ target: 邮箱, code: row!.code, password: "new12345" }, "password"))).status).toBe(200);

    expect((await token路由.POST(发({ target: 邮箱, password: "old12345" }, "token"))).status).toBe(401);
    expect((await token路由.POST(发({ target: 邮箱, password: "new12345" }, "token"))).status).toBe(200);
  });
});
