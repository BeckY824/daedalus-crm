/**
 * 桌面端注册：开一个**只有账号、没有工作区**的号。
 *
 * 和网页 /signup 的区别只有一处，但这一处是整个方向：网页注册要在我们服务器上
 * 开一个业务库文件，桌面端的数据在用户自己机器上，云端只管账号和模型网关。
 * 所以第一条就钉「注册完之后工作区数一个没多」——那是最容易在某次重构里被悄悄
 * 接回 createWorkspace 的地方。
 *
 * 其余钉的是「和网页共用同一套闸」：关掉自助注册时它也得关、临时邮箱一样挡、
 * 每个 IP 每天一样只放 3 个。少一条，桌面端就成了绕过网页那些限制的后门。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-reg-${process.pid}`);

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
});

afterAll(() => {
  delete process.env.MULTI_TENANT;
  fs.rmSync(临时根, { recursive: true, force: true });
});

let n = 0;
const 新邮箱 = () => `d${n++}@example.com`;
/** 没有反代时拿不到来源 IP，规则里按 null 处理；要验 IP 那几条就显式给一个 */
const 无IP = null;

describe("只开账号，不开工作区", () => {
  it("注册成功，工作区数一个没多，免费次数按账号记", async () => {
    const { 注册账号 } = await import("@/lib/tenant/register-account");
    const { control } = await import("@/lib/tenant/control");
    const { 余额, 注册赠送 } = await import("@/lib/tenant/credits");

    const 前 = await control.workspace.count();
    const r = await 注册账号({ target: 新邮箱(), password: "abcd1234", agreed: true }, 无IP);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(await control.workspace.count(), "桌面端注册不该在服务器上建库").toBe(前);
    expect(await control.membership.count({ where: { accountId: r.account.id } })).toBe(0);
    expect((await 余额({ kind: "account", id: r.account.id })).还剩).toBe(注册赠送);
  });

  it("同一个邮箱注册不了第二次", async () => {
    const { 注册账号 } = await import("@/lib/tenant/register-account");
    const 邮箱 = 新邮箱();
    expect((await 注册账号({ target: 邮箱, password: "abcd1234", agreed: true }, 无IP)).ok).toBe(true);
    const 再 = await 注册账号({ target: 邮箱, password: "abcd1234", agreed: true }, 无IP);
    expect(再.ok).toBe(false);
    if (!再.ok) expect(再.error).toContain("注册过");
  });
});

describe("和网页共用同一套闸", () => {
  it("关掉自助注册时，桌面端这条也关——否则它就是个后门", async () => {
    const { 注册账号, 发送注册码 } = await import("@/lib/tenant/register-account");
    const { control } = await import("@/lib/tenant/control");
    process.env.SIGNUP_REDIRECT = "https://ai-daedalus.com/demo.html";

    const 前 = await control.account.count();
    expect((await 注册账号({ target: 新邮箱(), password: "abcd1234", agreed: true }, 无IP)).ok).toBe(false);
    expect((await 发送注册码(新邮箱(), 无IP)).ok).toBe(false);
    // 返回失败不够，得确认真的什么都没留下
    expect(await control.account.count()).toBe(前);
  });

  it("临时邮箱、弱密码、没勾条款，一样都不放过", async () => {
    const { 注册账号 } = await import("@/lib/tenant/register-account");
    const 弱 = await 注册账号({ target: 新邮箱(), password: "abc", agreed: true }, 无IP);
    const 临时 = await 注册账号({ target: "x@mailinator.com", password: "abcd1234", agreed: true }, 无IP);
    const 没勾 = await 注册账号({ target: 新邮箱(), password: "abcd1234" }, 无IP);
    expect([弱.ok, 临时.ok, 没勾.ok]).toEqual([false, false, false]);
    if (!没勾.ok) expect(没勾.error).toContain("用户协议");
  });

  it("手机号不收：这条路只认邮箱，和网页注册一致", async () => {
    const { 注册账号 } = await import("@/lib/tenant/register-account");
    const r = await 注册账号({ target: "13800138000", password: "abcd1234", agreed: true }, 无IP);
    expect(r.ok).toBe(false);
  });

  it("同一个出口 IP 每天最多 3 个，和网页共用同一个计数", async () => {
    /**
     * 共用很重要：各记各的话，「网页开满 3 个再开桌面端」就能一天开 6 个，
     * 而注册送 30 次 AI，这就是一条批量薅额度的路。
     */
    const { 注册账号 } = await import("@/lib/tenant/register-account");
    const { 今日注册数 } = await import("@/lib/rate-limit");
    const ip = "198.51.100.7";
    for (let i = 0; i < 3; i++) {
      expect((await 注册账号({ target: 新邮箱(), password: "abcd1234", agreed: true }, ip)).ok).toBe(true);
    }
    const 第四个 = await 注册账号({ target: 新邮箱(), password: "abcd1234", agreed: true }, ip);
    expect(第四个.ok).toBe(false);
    if (!第四个.ok) expect(第四个.error).toContain("明天");
    // 数进的是 rate-limit 里那一本，网页注册读写的也是它
    expect(今日注册数(ip)).toBe(3);
  });
});

describe("要验证码的那条路", () => {
  it("打开 SIGNUP_VERIFY 之后，没有码注册不了；码对了才成", async () => {
    const { 注册账号, 发送注册码 } = await import("@/lib/tenant/register-account");
    const { control } = await import("@/lib/tenant/control");
    process.env.SIGNUP_VERIFY = "1";
    const 邮箱 = 新邮箱();

    expect((await 注册账号({ target: 邮箱, password: "abcd1234", agreed: true }, 无IP)).ok).toBe(false);

    const 发 = await 发送注册码(邮箱, 无IP);
    expect(发.ok).toBe(true);
    const row = await control.verifyCode.findFirst({ where: { target: 邮箱, purpose: "signup", usedAt: null }, orderBy: { createdAt: "desc" } });
    expect((await 注册账号({ target: 邮箱, password: "abcd1234", code: "000000", agreed: true }, 无IP)).ok).toBe(false);
    expect((await 注册账号({ target: 邮箱, password: "abcd1234", code: row!.code, agreed: true }, 无IP)).ok).toBe(true);
  });

  it("找回密码的码换不来一个新账号——两种用途各认各的", async () => {
    const { 注册账号 } = await import("@/lib/tenant/register-account");
    const { issueCode } = await import("@/lib/tenant/accounts");
    process.env.SIGNUP_VERIFY = "1";
    const 邮箱 = 新邮箱();
    const r = await issueCode(邮箱, "reset");
    if (!r.ok) throw new Error(r.error);
    expect((await 注册账号({ target: 邮箱, password: "abcd1234", code: r.code, agreed: true }, 无IP)).ok).toBe(false);
  });
});
