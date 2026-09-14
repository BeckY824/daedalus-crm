/**
 * 自助注册开关（SIGNUP_REDIRECT）。
 *
 * 关掉自助注册时，只让页面跳转是不够的：Server Action 是独立的 HTTP 端点，
 * 不经过页面也调得到。所以两个动作都必须自己拒绝——
 * 尤其是发验证码，那是唯一一个未登录就能触发外部计费动作的接口。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

// 这两个动作要 Next 的请求上下文；这里验的是开关，不是限流与会话
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
});

afterEach(() => {
  delete process.env.SIGNUP_REDIRECT;
});

afterAll(() => {
  delete process.env.MULTI_TENANT;
  fs.rmSync(临时根, { recursive: true, force: true });
});

describe("配了 SIGNUP_REDIRECT 就等于关闭自助注册", () => {
  it("直接调 signup 也建不出工作区", async () => {
    const { signup } = await import("@/app/signup/actions");
    const { control } = await import("@/lib/tenant/control");
    process.env.SIGNUP_REDIRECT = "https://ai-daedalus.com/demo.html";

    const 前 = await control.workspace.count();
    const r = await signup({
      target: "13800139002",
      code: "123456",
      password: "abcd1234",
      name: "陌生人",
      workspace: "自己开的",
    });

    expect(r.ok).toBe(false);
    // 返回失败不够，得确认真的什么都没留下
    expect(await control.workspace.count()).toBe(前);
    expect(await control.account.count({ where: { phone: "13800139002" } })).toBe(0);
  });

  it("空字符串不算关闭——免得 .env 里留个空值把注册莫名其妙关掉", async () => {
    const { signup } = await import("@/app/signup/actions");
    process.env.SIGNUP_REDIRECT = "   ";
    const r = await signup({ target: "不是手机号也不是邮箱", code: "x", password: "abcd1234", name: "n", workspace: "w" });
    // 走到了格式校验那一步，说明开关没有拦它
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("手机号或邮箱");
  });

  it("不配就照常开放：给个真激活码能开出工作区", async () => {
    const { signup } = await import("@/app/signup/actions");
    const { 生成并入库 } = await import("@/lib/tenant/activation");
    const { control } = await import("@/lib/tenant/control");
    // 这条要真开工作区，得有模板库
    const { execFileSync } = await import("node:child_process");
    const path = await import("node:path");
    const tpl = path.join(临时根, "_template.db");
    execFileSync("node", ["--experimental-sqlite", "scripts/build-template.mjs", tpl], { stdio: "pipe" });
    process.env.WORKSPACE_DIR = 临时根;
    process.env.WORKSPACE_TEMPLATE = tpl;

    const [code] = await 生成并入库(1);
    const r = await signup({ target: "13800139003", code, password: "abcd1234", name: "陌生人", workspace: "自己开的" });
    expect(r.ok).toBe(true);
    const used = await control.activationCode.findUnique({ where: { code } });
    expect(used!.usedAt).not.toBeNull();
    expect(used!.workspaceId).toBeTruthy();
    // 同一个码第二次不行
    const 再 = await signup({ target: "13800139004", code, password: "abcd1234", name: "x", workspace: "y" });
    expect(再.ok).toBe(false);
  });
});
