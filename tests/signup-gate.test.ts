/**
 * 自助注册：开关、密码、可选邀请码、条款勾选、赠送，以及可选的验证码。
 *
 * 默认不要验证码——填账号密码就能注册。验证码要一条发码通道，而通道要等
 * （短信要备案、邮件要域名验证），为它把注册挡在门外不值。
 * 通道配好后 SIGNUP_VERIFY=1 打开，这里两种模式都钉住。
 *
 * 关掉自助注册（SIGNUP_REDIRECT）时，只让页面跳转是不够的：Server Action 是独立的 HTTP 端点，
 * 不经过页面也调得到。所以两个动作都必须自己拒绝——
 * 尤其是发验证码，那是唯一一个未登录就能触发外部计费动作的接口。
 *
 * 2026-09-15 起注册**不再认任何码**（一次性激活码、万能邀请码整套下线），
 * 最后一组用例钉的就是这件事真的做完了，而不是只把表单那一栏藏起来。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";

// 这两个动作要 Next 的请求上下文；这里验的是规则，不是会话
vi.mock("next/headers", () => ({
  headers: async () => new Map([["x-forwarded-for", "203.0.113.9"]]),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-gate-${process.pid}`);

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

  // 真开工作区要有模板库
  const tpl = path.join(临时根, "_template.db");
  execFileSync("node", ["--experimental-sqlite", "scripts/build-template.mjs", tpl], { stdio: "pipe" });
  process.env.WORKSPACE_DIR = 临时根;
  process.env.WORKSPACE_TEMPLATE = tpl;
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

/** 走一遍「发码 → 从库里拿到码」。没配通道时码只打在日志里，测试直接读库 */
async function 拿验证码(target: string): Promise<string> {
  const { requestCode } = await import("@/app/signup/actions");
  const { control } = await import("@/lib/tenant/control");
  const r = await requestCode(target);
  if (!r.ok) throw new Error(r.error);
  const row = await control.verifyCode.findFirst({ where: { target, purpose: "signup", usedAt: null }, orderBy: { createdAt: "desc" } });
  return row!.code;
}

let n = 0;
function 新邮箱() {
  return `u${n++}@example.com`;
}

describe("配了 SIGNUP_REDIRECT 就等于关闭自助注册", () => {
  it("发码与注册都被拒，什么都不留下", async () => {
    const { requestCode, signup } = await import("@/app/signup/actions");
    const { control } = await import("@/lib/tenant/control");
    process.env.SIGNUP_REDIRECT = "https://ai-daedalus.com/demo.html";

    process.env.SIGNUP_VERIFY = "1";
    expect((await requestCode("someone@example.com")).ok).toBe(false);
    const 前 = await control.workspace.count();
    const r = await signup({ target: "someone@example.com", code: "123456", password: "abcd1234", workspace: "自己开的", agreed: true });
    expect(r.ok).toBe(false);
    // 返回失败不够，得确认真的什么都没留下
    expect(await control.workspace.count()).toBe(前);
    expect(await control.account.count({ where: { phone: "someone@example.com" } })).toBe(0);
  });

  it("空字符串不算关闭——免得 .env 里留个空值把注册莫名其妙关掉", async () => {
    const { signup } = await import("@/app/signup/actions");
    process.env.SIGNUP_REDIRECT = "   ";
    const r = await signup({ target: "不是邮箱", code: "x", password: "abcd1234", workspace: "w", agreed: true });
    // 走到了格式校验那一步，说明开关没有拦它
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("邮箱");
  });
});

describe("默认不要验证码：填账号密码就能注册", () => {
  it("手机号 + 密码直接开出工作区，并送注册赠送", async () => {
    const { signup } = await import("@/app/signup/actions");
    const { 查额度, 注册赠送 } = await import("@/lib/tenant/ai-allowance");
    const { control } = await import("@/lib/tenant/control");
    const 邮箱 = 新邮箱();
    const r = await signup({ target: 邮箱, code: "", password: "abcd1234", workspace: "不用码的团队", agreed: true });
    expect(r.ok).toBe(true);
    const ws = await control.workspace.findFirst({ where: { name: "不用码的团队" } });
    expect((await 查额度(ws!.id)).还剩).toBe(注册赠送);
  });

  it("密码必须够长且含字母和数字——不验证手机号时，密码是唯一一道门", async () => {
    const { signup } = await import("@/app/signup/actions");
    for (const pw of ["abc123", "abcdefgh", "12345678", ""]) {
      const r = await signup({ target: 新邮箱(), code: "", password: pw, workspace: "弱密码" + pw, agreed: true });
      expect(r.ok, `密码 ${JSON.stringify(pw)} 不该通过`).toBe(false);
    }
  });

  it("临时邮箱照样拒——不发码了，这条就是挡它的唯一一道闸", async () => {
    const { signup } = await import("@/app/signup/actions");
    const r = await signup({ target: "someone@mailinator.com", code: "", password: "abcd1234", workspace: "临时邮箱", agreed: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("常用邮箱");
  });

  it("没勾条款一样开不了", async () => {
    const { signup } = await import("@/app/signup/actions");
    expect((await signup({ target: 新邮箱(), code: "", password: "abcd1234", workspace: "没勾" })).ok).toBe(false);
  });

  it("同一个号注册两次，第二次拒", async () => {
    const { signup } = await import("@/app/signup/actions");
    const 邮箱 = 新邮箱();
    expect((await signup({ target: 邮箱, code: "", password: "abcd1234", workspace: "头一次" + 邮箱, agreed: true })).ok).toBe(true);
    const 再 = await signup({ target: 邮箱, code: "", password: "abcd1234", workspace: "第二次" + 邮箱, agreed: true });
    expect(再.ok).toBe(false);
    if (!再.ok) expect(再.error).toContain("注册过");
  });

  it("这时候发码接口直接告诉你不用发", async () => {
    const { requestCode } = await import("@/app/signup/actions");
    const r = await requestCode(新邮箱());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不需要验证码");
  });
});

describe("打开 SIGNUP_VERIFY 之后要验证码", () => {
  beforeEach(() => {
    process.env.SIGNUP_VERIFY = "1";
  });

  it("手机号一律拒——注册只收邮箱", async () => {
    const { requestCode, signup } = await import("@/app/signup/actions");
    const 发 = await requestCode("13900001234");
    expect(发.ok).toBe(false);
    if (!发.ok) expect(发.error).toContain("邮箱");
    // 表单不画手机号那一栏，但 Server Action 是独立端点，得自己拦
    const 开 = await signup({ target: "13900001234", code: "123456", password: "abcd1234", workspace: "手机号注册", agreed: true });
    expect(开.ok).toBe(false);
    if (!开.ok) expect(开.error).toContain("邮箱");
  });

  it("手机号：发码、填对、开出工作区，并送注册赠送", async () => {
    const { signup } = await import("@/app/signup/actions");
    const { 查额度, 注册赠送 } = await import("@/lib/tenant/ai-allowance");
    const { control } = await import("@/lib/tenant/control");
    const 邮箱 = 新邮箱();
    const code = await 拿验证码(邮箱);
    const r = await signup({ target: 邮箱, code, password: "abcd1234", workspace: "启明教育", agreed: true });
    expect(r.ok).toBe(true);
    const ws = await control.workspace.findFirst({ where: { name: "启明教育" } });
    expect((await 查额度(ws!.id)).还剩).toBe(注册赠送);
  });

  it("验证码不对开不了；对的码只能用一次", async () => {
    const { signup } = await import("@/app/signup/actions");
    const 邮箱 = 新邮箱();
    const code = await 拿验证码(邮箱);
    const 错 = await signup({ target: 邮箱, code: "000000", password: "abcd1234", workspace: "y", agreed: true });
    expect(错.ok).toBe(false);
    expect((await signup({ target: 邮箱, code, password: "abcd1234", workspace: "y1" + n, agreed: true })).ok).toBe(true);
  });

  it("没勾条款开不了——服务端也要验，表单上的勾选框绕得过", async () => {
    const { signup } = await import("@/app/signup/actions");
    const 邮箱 = 新邮箱();
    const code = await 拿验证码(邮箱);
    const r = await signup({ target: 邮箱, code, password: "abcd1234", workspace: "y" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("用户协议");
  });

  it("临时邮箱不给发码", async () => {
    const { requestCode } = await import("@/app/signup/actions");
    const r = await requestCode("a@mailinator.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("常用邮箱");
  });

  it("同一个 IP 一天最多开 3 个——注册是免费送次数的入口，不封顶会被脚本薅", async () => {
    const { signup, requestCode } = await import("@/app/signup/actions");
    const { 重置限流 } = await import("@/lib/rate-limit");
    for (let i = 0; i < 3; i++) {
      重置限流();
      const 邮箱 = 新邮箱();
      const code = await 拿验证码(邮箱);
      expect((await signup({ target: 邮箱, code, password: "abcd1234", workspace: `刷号${i}${n}`, agreed: true })).ok).toBe(true);
    }
    重置限流();
    const r = await requestCode(新邮箱());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("明天");
  });
});

describe("不再认任何码", () => {
  beforeEach(() => {
    process.env.SIGNUP_VERIFY = "1";
  });

  /**
   * 整套码 2026-09-15 下线（一次性激活码、万能邀请码、演示码）。
   * 钉在这里是因为「下线」很容易只做一半——表单去掉那一栏，Server Action 还照收，
   * 于是老页面、老脚本、或者直接调接口的人仍然能拿码换到额外的免费次数。
   */
  it("多传一个 invite 字段不会改变任何结果：不报错，也不多送", async () => {
    const { signup } = await import("@/app/signup/actions");
    const { 查额度, 注册赠送 } = await import("@/lib/tenant/ai-allowance");
    const { control } = await import("@/lib/tenant/control");
    const 邮箱 = 新邮箱();
    const code = await 拿验证码(邮箱);
    // 老客户端还会带这个字段，服务端应当把它当不存在
    const r = await signup({ target: 邮箱, code, password: "abcd1234", workspace: "带了码", agreed: true, ...{ invite: "ABCD-EFGH-JKLM" } } as Parameters<typeof signup>[0]);
    expect(r.ok).toBe(true);
    const ws = await control.workspace.findFirst({ where: { name: "带了码" } });
    expect((await 查额度(ws!.id)).上限).toBe(注册赠送);
  });

  it("控制面里已经没有那三张码表的客户端了", async () => {
    /** 删表是不可逆的，所以线上那三张表留着；但代码里再也不该碰得到它们 */
    const { control } = await import("@/lib/tenant/control");
    const c = control as unknown as Record<string, unknown>;
    expect(c.activationCode).toBeUndefined();
    expect(c.demoCode).toBeUndefined();
    expect(c.trialMasterCode).toBeUndefined();
  });
});
