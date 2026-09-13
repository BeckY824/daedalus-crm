/**
 * 注册、验证码、账号。
 *
 * 验证码这块是唯一一个**未登录就能触发外部计费动作**的接口（发短信要钱），
 * 所以重点不在「能不能注册成功」，在「能不能被刷」：一次性、会过期、
 * 尝试有上限、重发有间隔。少一条就是一笔真金白银的账单。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-acc-${process.pid}`);

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
  vi.useRealTimers();
  fs.rmSync(临时根, { recursive: true, force: true });
});

describe("登录标识", () => {
  it("认中国大陆手机号，不认乱七八糟的", async () => {
    const { isPhone } = await import("@/lib/tenant/accounts");
    expect(isPhone("13800138000")).toBe(true);
    expect(isPhone("138 0013 8000")).toBe(true);
    expect(isPhone("12800138000")).toBe(false); // 12 开头不是手机号
    expect(isPhone("1380013800")).toBe(false); // 少一位
    expect(isPhone("+8613800138000")).toBe(false); // 带国际区号的另说，现在不收
  });

  it("手机号和邮箱各自认得出来，都不像就拒", async () => {
    const { parseTarget } = await import("@/lib/tenant/accounts");
    expect(parseTarget("13800138000")?.kind).toBe("phone");
    expect(parseTarget(" Lin@Example.COM ")).toEqual({ kind: "email", value: "lin@example.com" });
    expect(parseTarget("我要注册")).toBeNull();
  });
});

describe("密码强度", () => {
  it("太短、纯字母、纯数字都不收", async () => {
    const { checkPassword } = await import("@/lib/tenant/accounts");
    expect(checkPassword("abc123")).toMatch(/8 位/);
    expect(checkPassword("abcdefghij")).toMatch(/字母和数字/);
    expect(checkPassword("1234567890")).toMatch(/字母和数字/);
    expect(checkPassword("qiming2026")).toBeNull();
  });

  it("超过 72 字节要拒，不能让人以为设了个超强密码", async () => {
    /**
     * bcrypt 只看前 72 字节，更长的部分被静默忽略。
     * 不拒的话，"前 72 位相同、后面不同"的两个密码会互相通用。
     */
    const { checkPassword } = await import("@/lib/tenant/accounts");
    expect(checkPassword("a1" + "x".repeat(80))).toMatch(/太长/);
  });
});

describe("验证码防刷", () => {
  it("同一个号 60 秒内不给重发", async () => {
    const { issueCode } = await import("@/lib/tenant/accounts");
    const 目标 = "13800000001";
    expect((await issueCode(目标)).ok).toBe(true);
    const 第二次 = await issueCode(目标);
    expect(第二次.ok).toBe(false);
    expect(!第二次.ok && 第二次.error).toMatch(/稍后/);
  });

  it("用过的码不能再用一次", async () => {
    const { issueCode, consumeCode } = await import("@/lib/tenant/accounts");
    const 目标 = "13800000002";
    const r = await issueCode(目标);
    if (!r.ok) throw new Error("发码本该成功");
    expect((await consumeCode(目标, r.code)).ok).toBe(true);
    // 同一个码第二次必须失败，否则一个码能反复注册
    expect((await consumeCode(目标, r.code)).ok).toBe(false);
  });

  it("填错的次数有上限，超了这条码直接作废", async () => {
    const { issueCode, consumeCode } = await import("@/lib/tenant/accounts");
    const 目标 = "13800000003";
    const r = await issueCode(目标);
    if (!r.ok) throw new Error("发码本该成功");
    for (let i = 0; i < 5; i++) {
      expect((await consumeCode(目标, "000000")).ok).toBe(false);
    }
    // 超限之后，连正确的码也不认——逼对方重新获取
    const 最后 = await consumeCode(目标, r.code);
    expect(最后.ok).toBe(false);
    expect(!最后.ok && 最后.error).toMatch(/次数过多/);
  });

  it("过期的码不认", async () => {
    const { issueCode, consumeCode } = await import("@/lib/tenant/accounts");
    const { control } = await import("@/lib/tenant/control");
    const 目标 = "13800000004";
    const r = await issueCode(目标);
    if (!r.ok) throw new Error("发码本该成功");
    // 把这条码的到期时间拨到过去
    await control.verifyCode.updateMany({ where: { target: 目标 }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const 结果 = await consumeCode(目标, r.code);
    expect(结果.ok).toBe(false);
    expect(!结果.ok && 结果.error).toMatch(/过期/);
  });

  it("没发过码就来核验，明确让人先去获取", async () => {
    const { consumeCode } = await import("@/lib/tenant/accounts");
    const r = await consumeCode("13800000009", "123456");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/先获取/);
  });
});

describe("账号", () => {
  it("密码是哈希存的，库里看不到明文", async () => {
    const { createAccount, verifyAccount } = await import("@/lib/tenant/accounts");
    const { control } = await import("@/lib/tenant/control");
    await createAccount({ target: { kind: "phone", value: "13811112222" }, password: "qiming2026", name: "林老师" });

    const row = await control.account.findFirst({ where: { phone: "13811112222" } });
    expect(row?.password).not.toContain("qiming2026");
    expect(row?.password.startsWith("$2")).toBe(true);

    expect(await verifyAccount("13811112222", "qiming2026")).toBeTruthy();
    expect(await verifyAccount("13811112222", "错的密码")).toBeNull();
  });

  it("不存在的账号与密码错返回同一种结果，不做查号接口", async () => {
    const { verifyAccount } = await import("@/lib/tenant/accounts");
    expect(await verifyAccount("13899998888", "随便")).toBeNull();
    expect(await verifyAccount("13811112222", "随便")).toBeNull();
  });

  it("停用的账号登不进来", async () => {
    const { verifyAccount } = await import("@/lib/tenant/accounts");
    const { control } = await import("@/lib/tenant/control");
    await control.account.updateMany({ where: { phone: "13811112222" }, data: { active: false } });
    expect(await verifyAccount("13811112222", "qiming2026")).toBeNull();
    await control.account.updateMany({ where: { phone: "13811112222" }, data: { active: true } });
  });
});
