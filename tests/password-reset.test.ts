/**
 * 找回密码。
 *
 * 这条路和注册一样是**未登录就能调**的，但它比注册更敏感：注册最多让人多开一个号，
 * 这里一旦松了就是别人的账号。所以钉的重点是三类：
 *
 *   查不出号 —— 对没注册过的邮箱，行为必须和注册过的一模一样（连节流都一样），
 *                否则这就是一个查我们客户名单的接口；
 *   进不去   —— 码一次性、分用途、错的不给过、弱密码不烧码；
 *   换了锁也换门 —— 改完密码，之前签出去的会话全部作废。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

// 两个动作都要 Next 的请求上下文；这里验的是规则，不是会话
vi.mock("next/headers", () => ({
  headers: async () => new Map([["x-forwarded-for", "203.0.113.9"]]),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-reset-${process.pid}`);

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
  const { 重置限流 } = await import("@/lib/rate-limit");
  重置限流();
});

afterAll(() => {
  delete process.env.MULTI_TENANT;
  fs.rmSync(临时根, { recursive: true, force: true });
});

let n = 0;
function 新邮箱() {
  return `r${n++}@example.com`;
}

/** 开一个只有账号、没有工作区的号。找回密码这条路不碰工作区 */
async function 建号(email: string, password = "old12345") {
  const { createAccount } = await import("@/lib/tenant/accounts");
  return createAccount({ target: { kind: "email", value: email }, password, name: "某人" });
}

/** 发一次码并从库里把它取出来。没配通道时码只打进日志，测试直接读库 */
async function 拿重置码(email: string): Promise<string> {
  const { 发送重置码 } = await import("@/app/forgot/actions");
  const { control } = await import("@/lib/tenant/control");
  const r = await 发送重置码(email);
  if (!r.ok) throw new Error(r.error);
  const row = await control.verifyCode.findFirst({
    where: { target: email, purpose: "reset", usedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return row!.code;
}

describe("这个部署有没有这条路", () => {
  it("自部署版没有：没有控制面账号，改密是管理员的事", async () => {
    const { 能找回密码 } = await import("@/lib/tenant/password-reset");
    expect(能找回密码({ NODE_ENV: "test" })).toBe(false);
    expect(能找回密码({ MULTI_TENANT: "1", NODE_ENV: "test" })).toBe(true);
  });

  it("线上没配 SMTP 就整个关掉——码只会打进日志，人对着空收件箱等", async () => {
    const { 能找回密码 } = await import("@/lib/tenant/password-reset");
    const 生产 = { MULTI_TENANT: "1", NODE_ENV: "production" };
    expect(能找回密码(生产)).toBe(false);
    expect(能找回密码({ ...生产, SMTP_HOST: "smtp", SMTP_USER: "u", SMTP_PASS: "p", SMTP_FROM: "f" })).toBe(true);
    // 缺一件都不算配好
    expect(能找回密码({ ...生产, SMTP_HOST: "smtp", SMTP_USER: "u", SMTP_PASS: "p" })).toBe(false);
  });

  it("关掉的时候两个动作自己也拒——页面绕得过，Server Action 绕不过", async () => {
    const { 发送重置码, 重置密码 } = await import("@/app/forgot/actions");
    delete process.env.MULTI_TENANT;
    try {
      expect((await 发送重置码("someone@example.com")).ok).toBe(false);
      expect((await 重置密码({ target: "someone@example.com", code: "123456", password: "new12345" })).ok).toBe(false);
    } finally {
      process.env.MULTI_TENANT = "1";
    }
  });
});

describe("不能拿它查号", () => {
  it("没注册过的邮箱也返回成功，只是没真发信", async () => {
    const { 发送重置码 } = await import("@/app/forgot/actions");
    const r = await 发送重置码(新邮箱());
    expect(r.ok).toBe(true);
  });

  it("连点两次时的节流提示，注册过的和没注册过的一模一样", async () => {
    /**
     * 这一条是整套里最容易漏的：如果只给真实账号存码，
     * 那么「刚发过了」就只会出现在真实账号上——连点两次就把号查出来了。
     * 所以不存在的号也要照走一遍 issueCode。
     */
    const { 发送重置码 } = await import("@/app/forgot/actions");
    const 有号 = 新邮箱();
    await 建号(有号);
    const 没号 = 新邮箱();

    await 发送重置码(有号);
    await 发送重置码(没号);
    const a = await 发送重置码(有号);
    const b = await 发送重置码(没号);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok && !b.ok) expect(a.error).toBe(b.error);
  });

  it("码错了不说是码错了还是号不存在，两种情况同一句话", async () => {
    const { 重置密码 } = await import("@/app/forgot/actions");
    const 有号 = 新邮箱();
    await 建号(有号);
    await 拿重置码(有号);
    const a = await 重置密码({ target: 有号, code: "000000", password: "new12345" });
    const b = await 重置密码({ target: 新邮箱(), code: "000000", password: "new12345" });
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
  });

  it("手机号是例外：直说只能用邮箱，不然他会等一条永远不来的短信", async () => {
    const { 发送重置码 } = await import("@/app/forgot/actions");
    const r = await 发送重置码("13800138000");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("邮箱");
  });
});

describe("走通一遍", () => {
  it("发码 → 设新密码 → 新密码能登、旧密码不能", async () => {
    const { verifyAccount } = await import("@/lib/tenant/accounts");
    const { 重置密码 } = await import("@/app/forgot/actions");
    const 邮箱 = 新邮箱();
    await 建号(邮箱, "old12345");

    const code = await 拿重置码(邮箱);
    expect((await 重置密码({ target: 邮箱, code, password: "new12345" })).ok).toBe(true);

    expect(await verifyAccount(邮箱, "new12345")).not.toBeNull();
    expect(await verifyAccount(邮箱, "old12345")).toBeNull();
  });

  it("一个码只能用一次：改完再拿同一个码改不动", async () => {
    const { verifyAccount } = await import("@/lib/tenant/accounts");
    const { 重置密码 } = await import("@/app/forgot/actions");
    const 邮箱 = 新邮箱();
    await 建号(邮箱);
    const code = await 拿重置码(邮箱);

    expect((await 重置密码({ target: 邮箱, code, password: "new12345" })).ok).toBe(true);
    expect((await 重置密码({ target: 邮箱, code, password: "hack12345" })).ok).toBe(false);
    expect(await verifyAccount(邮箱, "new12345")).not.toBeNull();
  });

  it("注册用的码改不了密码——两种用途各认各的", async () => {
    const { issueCode } = await import("@/lib/tenant/accounts");
    const { 重置密码 } = await import("@/app/forgot/actions");
    const 邮箱 = 新邮箱();
    await 建号(邮箱);
    const r = await issueCode(邮箱, "signup");
    if (!r.ok) throw new Error(r.error);
    expect((await 重置密码({ target: 邮箱, code: r.code, password: "new12345" })).ok).toBe(false);
  });

  it("弱密码被挡在验码之前，不白烧一个码", async () => {
    /** 先验码再判密码的话，人填了个太短的密码就得重新收一封信，纯属找骂 */
    const { 重置密码 } = await import("@/app/forgot/actions");
    const 邮箱 = 新邮箱();
    await 建号(邮箱);
    const code = await 拿重置码(邮箱);

    const 弱 = await 重置密码({ target: 邮箱, code, password: "abc" });
    expect(弱.ok).toBe(false);
    // 码还在，改成合格的密码立刻能用
    expect((await 重置密码({ target: 邮箱, code, password: "new12345" })).ok).toBe(true);
  });

  it("停用的号不给重置，但话术和正常情况一样", async () => {
    const { control } = await import("@/lib/tenant/control");
    const { 重置密码 } = await import("@/app/forgot/actions");
    const 邮箱 = 新邮箱();
    const a = await 建号(邮箱);
    const code = await 拿重置码(邮箱);
    await control.account.update({ where: { id: a.id }, data: { active: false } });
    expect((await 重置密码({ target: 邮箱, code, password: "new12345" })).ok).toBe(false);
  });

  it("改完密码把登录限流清掉：刚试错到冷却的人不该再等 5 分钟", async () => {
    const { 检查限流, 记一次失败, 阈值 } = await import("@/lib/rate-limit");
    const { 重置密码 } = await import("@/app/forgot/actions");
    const 邮箱 = 新邮箱();
    await 建号(邮箱);
    for (let i = 0; i < 阈值; i++) 记一次失败(`u:${邮箱}`);
    expect(检查限流(`u:${邮箱}`)).not.toBeNull();

    const code = await 拿重置码(邮箱);
    expect((await 重置密码({ target: 邮箱, code, password: "new12345" })).ok).toBe(true);
    expect(检查限流(`u:${邮箱}`)).toBeNull();
  });
});

describe("改完密码，旧会话不认了", () => {
  it("改密之前签的票作废，之后（含同一秒）签的还认", async () => {
    /**
     * 同一秒那条不是抠细节：JWT 的 iat 只有秒，改完密码立刻登录就落在同一秒里，
     * 比较写成「小于等于」的话，新签的那张票会被自己的这条线杀掉——
     * 表现是「改完密码登进去，一刷新又弹回登录页」。
     */
    const { 记一次改密, 会话已作废 } = await import("@/lib/tenant/session-cutoff");
    const a = await 建号(新邮箱());
    const 此刻 = new Date("2026-09-14T10:00:00.500Z");
    const 秒 = Math.floor(此刻.getTime() / 1000);

    // 没改过密码的号，任何票都认
    expect(await 会话已作废(a.id, 秒 - 9999, 此刻)).toBe(false);

    await 记一次改密(a.id, 此刻);
    expect(await 会话已作废(a.id, 秒 - 1, 此刻)).toBe(true);
    expect(await 会话已作废(a.id, 秒, 此刻)).toBe(false);
    expect(await 会话已作废(a.id, 秒 + 1, 此刻)).toBe(false);
  });

  it("没有 iat 的票当旧票拒掉——jose 签的一定带 iat，没有就是来路不明", async () => {
    const { 记一次改密, 会话已作废 } = await import("@/lib/tenant/session-cutoff");
    const a = await 建号(新邮箱());
    await 记一次改密(a.id);
    expect(await 会话已作废(a.id, undefined)).toBe(true);
  });

  it("线落在未来时不拿它杀人：时钟回拨不该把所有人挡在门外", async () => {
    const { 记一次改密, 会话已作废 } = await import("@/lib/tenant/session-cutoff");
    const a = await 建号(新邮箱());
    const 未来 = new Date(Date.now() + 86400_000);
    await 记一次改密(a.id, 未来);
    const 现在 = new Date();
    expect(await 会话已作废(a.id, Math.floor(现在.getTime() / 1000), 现在)).toBe(false);
  });

  it("走完真正的找回流程，这条线就落下了", async () => {
    const { control } = await import("@/lib/tenant/control");
    const { 重置密码 } = await import("@/app/forgot/actions");
    const 邮箱 = 新邮箱();
    const a = await 建号(邮箱);
    expect(await control.sessionCutoff.findUnique({ where: { accountId: a.id } })).toBeNull();

    const code = await 拿重置码(邮箱);
    expect((await 重置密码({ target: 邮箱, code, password: "new12345" })).ok).toBe(true);
    expect(await control.sessionCutoff.findUnique({ where: { accountId: a.id } })).not.toBeNull();
  });
});
