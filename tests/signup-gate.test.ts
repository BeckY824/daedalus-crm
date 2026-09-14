/**
 * 自助注册：开关、验证码、可选邀请码、条款勾选、赠送。
 *
 * 关掉自助注册（SIGNUP_REDIRECT）时，只让页面跳转是不够的：Server Action 是独立的 HTTP 端点，
 * 不经过页面也调得到。所以两个动作都必须自己拒绝——
 * 尤其是发验证码，那是唯一一个未登录就能触发外部计费动作的接口。
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
function 新手机() {
  return `1390000${String(n++).padStart(4, "0")}`;
}

describe("配了 SIGNUP_REDIRECT 就等于关闭自助注册", () => {
  it("发码与注册都被拒，什么都不留下", async () => {
    const { requestCode, signup } = await import("@/app/signup/actions");
    const { control } = await import("@/lib/tenant/control");
    process.env.SIGNUP_REDIRECT = "https://ai-daedalus.com/demo.html";

    expect((await requestCode("13800139002")).ok).toBe(false);
    const 前 = await control.workspace.count();
    const r = await signup({ target: "13800139002", code: "123456", password: "abcd1234", name: "陌生人", workspace: "自己开的", agreed: true });
    expect(r.ok).toBe(false);
    // 返回失败不够，得确认真的什么都没留下
    expect(await control.workspace.count()).toBe(前);
    expect(await control.account.count({ where: { phone: "13800139002" } })).toBe(0);
  });

  it("空字符串不算关闭——免得 .env 里留个空值把注册莫名其妙关掉", async () => {
    const { signup } = await import("@/app/signup/actions");
    process.env.SIGNUP_REDIRECT = "   ";
    const r = await signup({ target: "不是手机号也不是邮箱", code: "x", password: "abcd1234", name: "n", workspace: "w", agreed: true });
    // 走到了格式校验那一步，说明开关没有拦它
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("手机号或邮箱");
  });
});

describe("验证码注册", () => {
  it("手机号：发码、填对、开出工作区，并送注册赠送", async () => {
    const { signup } = await import("@/app/signup/actions");
    const { 查额度, 注册赠送 } = await import("@/lib/tenant/ai-allowance");
    const { control } = await import("@/lib/tenant/control");
    const 手机 = 新手机();
    const code = await 拿验证码(手机);
    const r = await signup({ target: 手机, code, password: "abcd1234", name: "林老师", workspace: "启明教育", agreed: true });
    expect(r.ok).toBe(true);
    const ws = await control.workspace.findFirst({ where: { name: "启明教育" } });
    expect((await 查额度(ws!.id)).还剩).toBe(注册赠送);
  });

  it("邮箱：同一套流程", async () => {
    const { signup } = await import("@/app/signup/actions");
    const 邮箱 = `u${n++}@example.com`;
    const code = await 拿验证码(邮箱);
    expect((await signup({ target: 邮箱, code, password: "abcd1234", name: "王", workspace: "邮箱团队", agreed: true })).ok).toBe(true);
  });

  it("验证码不对开不了；对的码只能用一次", async () => {
    const { signup } = await import("@/app/signup/actions");
    const 手机 = 新手机();
    const code = await 拿验证码(手机);
    const 错 = await signup({ target: 手机, code: "000000", password: "abcd1234", name: "x", workspace: "y", agreed: true });
    expect(错.ok).toBe(false);
    expect((await signup({ target: 手机, code, password: "abcd1234", name: "x", workspace: "y1" + n, agreed: true })).ok).toBe(true);
  });

  it("没勾条款开不了——服务端也要验，表单上的勾选框绕得过", async () => {
    const { signup } = await import("@/app/signup/actions");
    const 手机 = 新手机();
    const code = await 拿验证码(手机);
    const r = await signup({ target: 手机, code, password: "abcd1234", name: "x", workspace: "y" });
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
      const 手机 = 新手机();
      const code = await 拿验证码(手机);
      expect((await signup({ target: 手机, code, password: "abcd1234", name: "x", workspace: `刷号${i}${n}`, agreed: true })).ok).toBe(true);
    }
    重置限流();
    const r = await requestCode(新手机());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("明天");
  });
});

describe("邀请码可选", () => {
  it("填万能码：多送邀请码赠送；万能码可反复用", async () => {
    const { signup } = await import("@/app/signup/actions");
    const { 换万能码, 展示 } = await import("@/lib/tenant/activation");
    const { 查额度, 注册赠送, 邀请码赠送 } = await import("@/lib/tenant/ai-allowance");
    const { control } = await import("@/lib/tenant/control");
    const master = 展示(await 换万能码()).toLowerCase();
    for (const 名 of ["万能甲", "万能乙"]) {
      const 手机 = 新手机();
      const code = await 拿验证码(手机);
      expect((await signup({ target: 手机, code, password: "abcd1234", name: "x", workspace: 名, invite: master, agreed: true })).ok).toBe(true);
      const ws = await control.workspace.findFirst({ where: { name: 名 } });
      expect((await 查额度(ws!.id)).上限).toBe(注册赠送 + 邀请码赠送);
    }
  });

  it("换了万能码，旧码立刻不认", async () => {
    const { signup } = await import("@/app/signup/actions");
    const { 换万能码 } = await import("@/lib/tenant/activation");
    const 旧 = await 换万能码();
    await 换万能码();
    const 手机 = 新手机();
    const code = await 拿验证码(手机);
    const r = await signup({ target: 手机, code, password: "abcd1234", name: "x", workspace: "旧码", invite: 旧, agreed: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("邀请码无效");
  });

  it("填旧的一次性激活码也认：多送、用一次作废", async () => {
    const { signup } = await import("@/app/signup/actions");
    const { 生成并入库 } = await import("@/lib/tenant/activation");
    const { 查额度, 注册赠送, 邀请码赠送 } = await import("@/lib/tenant/ai-allowance");
    const { control } = await import("@/lib/tenant/control");
    const [once] = await 生成并入库(1);
    const 手机 = 新手机();
    const code = await 拿验证码(手机);
    expect((await signup({ target: 手机, code, password: "abcd1234", name: "x", workspace: "一次性甲", invite: once, agreed: true })).ok).toBe(true);
    const ws = await control.workspace.findFirst({ where: { name: "一次性甲" } });
    expect((await 查额度(ws!.id)).上限).toBe(注册赠送 + 邀请码赠送);
    const used = await control.activationCode.findUnique({ where: { code: once } });
    expect(used!.usedAt).not.toBeNull();
    expect(used!.workspaceId).toBe(ws!.id);

    const 手机2 = 新手机();
    const code2 = await 拿验证码(手机2);
    const 再 = await signup({ target: 手机2, code: code2, password: "abcd1234", name: "x", workspace: "一次性乙", invite: once, agreed: true });
    expect(再.ok).toBe(false);
  });

  it("邀请码填错要报错、且不消耗验证码——人得能改了再交", async () => {
    const { signup } = await import("@/app/signup/actions");
    const 手机 = 新手机();
    const code = await 拿验证码(手机);
    const r = await signup({ target: 手机, code, password: "abcd1234", name: "x", workspace: "填错", invite: "ABCD-EFGH-JKLM", agreed: true });
    expect(r.ok).toBe(false);
    // 同一个验证码去掉邀请码再交，能成
    expect((await signup({ target: 手机, code, password: "abcd1234", name: "x", workspace: "填错后改好", agreed: true })).ok).toBe(true);
  });
});
