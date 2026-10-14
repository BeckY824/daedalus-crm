import { closeTestDatabases } from "./close-databases";
/**
 * 第六轮对抗复查：应用内注册的云端接口（/api/account/signup/start、/api/account/signup）。
 *
 * 红的是确认的问题，保持红，等修。harness 照抄 tests/account-endpoints.test.ts。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-r6-signup-${process.pid}`);

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
  vi.unstubAllEnvs();
  delete process.env.SIGNUP_REDIRECT;
  delete process.env.SIGNUP_VERIFY;
});

afterAll(async () => {
  delete process.env.MULTI_TENANT;
  await closeTestDatabases(临时根);
  fs.rmSync(临时根, { recursive: true, force: true });
});

let n = 0;
const 新邮箱 = () => `r6s${n++}@example.com`;

function 发(body: unknown, 路径: string, ip = "203.0.113.61") {
  return new Request(`https://app.example.com/api/account/${路径}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

/** 路由抛出去（Next 会回 500）也折成一个状态码，好断言 */
async function 状态(p: Promise<Response>): Promise<number> {
  try {
    return (await p).status;
  } catch {
    return 500;
  }
}

describe("R6-1 老用户的「继续」被注册专用的闸挡住（生产开着 SIGNUP_VERIFY）", () => {
  it("同一出口 IP 今天已经注册满 3 个：老用户点「继续」应该被带去输密码（409），而不是被告知「今天注册够多了」", async () => {
    process.env.SIGNUP_VERIFY = "1";
    const { POST } = await import("@/app/api/account/signup/start/route");
    const { createAccount } = await import("@/lib/tenant/accounts");
    const { 记一次注册 } = await import("@/lib/rate-limit");
    const ip = "203.0.113.62";
    const 老号 = 新邮箱();
    await createAccount({ target: { kind: "email", value: 老号 }, password: "abcd1234", name: "老用户" });
    // 同一个办公室出口，今天有 3 个同事刚注册过
    记一次注册(ip);
    记一次注册(ip);
    记一次注册(ip);

    const r = await POST(发({ target: 老号 }, "signup/start", ip));
    // 实际：400「今天从这个网络注册的账号已经够多了，明天再来」——老用户的登录被挡在门口
    expect(r.status).toBe(409);
  });

  it("发码限流桶冷却中：老用户点「继续」也被拒（操作太频繁），而不是去输密码", async () => {
    process.env.SIGNUP_VERIFY = "1";
    const { POST } = await import("@/app/api/account/signup/start/route");
    const { createAccount } = await import("@/lib/tenant/accounts");
    const ip = "203.0.113.63";
    const 老号 = 新邮箱();
    await createAccount({ target: { kind: "email", value: 老号 }, password: "abcd1234", name: "老用户" });
    // 只预填发码桶；查号桶另行验证30次上限。
    const { 记一次失败, IP阈值 } = await import("@/lib/rate-limit");
    for (let i = 0; i < IP阈值; i++) 记一次失败(`code:${ip}`, Date.now(), IP阈值);
    const r = await POST(发({ target: 老号 }, "signup/start", ip));
    expect(r.status).toBe(409);
  });
});

describe("R6-2 验证码一码 5 次的上限在并发下不成立", () => {
  it("同一个码同时打 40 次错码：判「验证码不对」的不该超过 5 次", async () => {
    process.env.SIGNUP_VERIFY = "1";
    const start = await import("@/app/api/account/signup/start/route");
    const signup = await import("@/app/api/account/signup/route");
    const 邮箱 = 新邮箱();
    expect((await start.POST(发({ target: 邮箱 }, "signup/start", "198.51.100.1"))).status).toBe(200);

    // 每个请求换一个出口 IP（signup:ip 桶也是先查后记，并发下同一个 IP 也一样漏）
    const rs = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        signup.POST(发({ target: 邮箱, code: String(100000 + i).padStart(6, "0").replace(/^1/, "0"), password: "abcd1234", agreed: true }, "signup", `198.51.100.${10 + i}`)),
      ),
    );
    const 被比对了 = (await Promise.all(rs.map((r) => r.json()))).filter((j: { error?: string }) => j.error === "验证码不对").length;
    // 这个数就是攻击者对这一个码实际拿到的猜测次数
    expect(被比对了).toBeLessThanOrEqual(5);
  });
});

describe("R6-2b 同一个洞在找回密码上：并发猜码 = 改别人的密码", () => {
  it("对一个真账号并发打 200 次错码，再夹一个对的：5 次上限早该把这个码作废，密码不该被改掉", async () => {
    const code路由 = await import("@/app/api/account/code/route");
    const pw路由 = await import("@/app/api/account/password/route");
    const token路由 = await import("@/app/api/account/token/route");
    const { control } = await import("@/lib/tenant/control");
    const { createAccount } = await import("@/lib/tenant/accounts");
    const 受害者 = 新邮箱();
    await createAccount({ target: { kind: "email", value: 受害者 }, password: "victim123", name: "受害者" });
    // 攻击者替受害者点「发验证码」——码进了受害者的邮箱，攻击者看不见
    expect((await code路由.POST(发({ target: 受害者 }, "code", "192.0.2.1"))).status).toBe(200);
    const row = await control.verifyCode.findFirst({ where: { target: 受害者, purpose: "reset", usedAt: null }, orderBy: { createdAt: "desc" } });

    // 一批里 200 个错码 + 那个对的（真实攻击里就是 1e6 空间里的一段）
    const 猜 = Array.from({ length: 200 }, (_, i) => String(i).padStart(6, "0"));
    猜.push(row!.code);
    const rs = await Promise.all(
      猜.map((c, i) => pw路由.POST(发({ target: 受害者, code: c, password: "attacker1" }, "password", `192.0.2.${(i % 250) + 2}`))),
    );
    const 被比对 = (await Promise.all(rs.map((r) => r.json()))).filter((j: { error?: string }) => j.error === "验证码不对").length;
    expect.soft(被比对).toBeLessThanOrEqual(5);
    // 攻击者的新密码换得到令牌 = 账号被接管
    expect((await token路由.POST(发({ target: 受害者, password: "attacker1" }, "token", "192.0.2.254"))).status).toBe(401);
  });
});

describe("R6-3 请求体字段类型不校验：公网接口回 500", () => {
  it("signup/start：target 不是字符串 → 应 400，实际抛错（500）", async () => {
    const { POST } = await import("@/app/api/account/signup/start/route");
    expect(await 状态(POST(发({ target: 12345 }, "signup/start")))).toBe(400);
  });

  it("signup/start：请求体是 JSON null → 应 400，实际抛错（500）", async () => {
    const { POST } = await import("@/app/api/account/signup/start/route");
    expect(await 状态(POST(发(null, "signup/start")))).toBe(400);
  });

  it("signup：target 不是字符串 → 应 400，实际抛错（500）", async () => {
    const { POST } = await import("@/app/api/account/signup/route");
    expect(await 状态(POST(发({ target: ["a@b.com"], password: "abcd1234", agreed: true }, "signup")))).toBe(400);
  });

  it("signup：验证码不是字符串（数字 123456）→ 应 400，实际抛错（500）", async () => {
    process.env.SIGNUP_VERIFY = "1";
    const start = await import("@/app/api/account/signup/start/route");
    const { POST } = await import("@/app/api/account/signup/route");
    const 邮箱 = 新邮箱();
    await start.POST(发({ target: 邮箱 }, "signup/start", "198.51.100.200"));
    expect(await 状态(POST(发({ target: 邮箱, code: 123456, password: "abcd1234", agreed: true }, "signup")))).toBe(400);
  });
});

describe("R6-4 不验证码的部署：「继续」对临时邮箱照样放去设密码", () => {
  it("临时邮箱在第一步就该被拦（发码那条路是这样），不该等人设完密码、勾完条款才说", async () => {
    const { POST } = await import("@/app/api/account/signup/start/route");
    const r = await POST(发({ target: `x${n++}@mailinator.com` }, "signup/start", "203.0.113.64"));
    expect(r.status).toBe(400);
  });
});


describe("继续登录与注册策略分离（H046）", () => {
  it("不验证码时发码桶冷却不挡老账号，关闭注册也允许老账号继续", async () => {
    const { POST } = await import("@/app/api/account/signup/start/route");
    const { createAccount } = await import("@/lib/tenant/accounts");
    const { 记一次失败, IP阈值 } = await import("@/lib/rate-limit");
    const email = 新邮箱(), ip = "203.0.113.110";
    await createAccount({ target: { kind: "email", value: email }, password: "abcd1234", name: "旧" });
    for (let i=0; i<IP阈值; i++) 记一次失败(`code:${ip}`, Date.now(), IP阈值);
    expect((await POST(发({ target: email }, "signup/start", ip))).status).toBe(409);
    process.env.SIGNUP_REDIRECT = "https://example.test/contact";
    expect((await POST(发({ target: email }, "signup/start", ip))).status).toBe(409);
    expect((await POST(发({ target: 新邮箱() }, "signup/start", ip))).status).toBe(400);
  });
  it("需验证码但SMTP未配或注册关闭，老账号不依赖发信通道", async () => {
    const { POST } = await import("@/app/api/account/signup/start/route");
    const { createAccount } = await import("@/lib/tenant/accounts");
    const email = 新邮箱();
    await createAccount({ target: { kind: "email", value: email }, password: "abcd1234", name: "旧" });
    process.env.SIGNUP_VERIFY = "1";
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("SMTP_HOST", "");
    expect((await POST(发({ target: email }, "signup/start", "203.0.113.111"))).status).toBe(409);
    process.env.SIGNUP_REDIRECT = "https://example.test/contact";
    expect((await POST(发({ target: email }, "signup/start", "203.0.113.111"))).status).toBe(409);
  });
  it("查号桶按30次封顶，两种验证码模式一致，不能因90次宽桶漏限", async () => {
    const { POST } = await import("@/app/api/account/signup/start/route");
    const { createAccount } = await import("@/lib/tenant/accounts");
    const { IP阈值, 重置限流 } = await import("@/lib/rate-limit");
    const email = 新邮箱();
    await createAccount({ target: { kind: "email", value: email }, password: "abcd1234", name: "旧" });
    for (const verify of ["0", "1"]) {
      重置限流(); process.env.SIGNUP_VERIFY = verify;
      for (let i=0; i<IP阈值; i++) expect((await POST(发({ target: email }, "signup/start", "203.0.113.112"))).status).toBe(409);
      expect((await POST(发({ target: email }, "signup/start", "203.0.113.112"))).status).toBe(400);
    }
  });
});
