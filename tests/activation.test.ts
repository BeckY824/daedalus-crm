/**
 * 试用激活码。它替代了注册时的短信/邮件验证码：码本身就是授权凭证。
 * 要钉的是"一码一用"在并发下也成立——两个人同时提交同一个码，只能有一个开出工作区。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// revalidatePath 要 Next 的请求上下文，单测里没有；它只影响页面缓存，和这里要验的授权无关
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-act-${process.pid}`);

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  process.env.MULTI_TENANT = "1";
  process.env.ADMIN_TOKEN = "t-admin";
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时根, "control.db")}`;
  const sql = execFileSync("npx", ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(临时根, "c.sql"), sql);
  execFileSync("node", ["--experimental-sqlite", "-e", `
    const { DatabaseSync } = require('node:sqlite'); const fs = require('node:fs');
    const db = new DatabaseSync(process.argv[1]); db.exec(fs.readFileSync(process.argv[2], 'utf8')); db.close();
  `, path.join(临时根, "control.db"), path.join(临时根, "c.sql")], { stdio: "pipe" });
});
afterAll(() => { delete process.env.MULTI_TENANT; delete process.env.ADMIN_TOKEN; fs.rmSync(临时根, { recursive: true, force: true }); });
beforeEach(async () => { const { control } = await import("@/lib/tenant/control"); await control.activationCode.deleteMany({}); });

describe("生成", () => {
  it("12 位、只用不易混的字符、互不重复", async () => {
    const { 生成并入库, 激活码长度 } = await import("@/lib/tenant/activation");
    const codes = await 生成并入库(50);
    expect(codes).toHaveLength(50);
    expect(new Set(codes).size).toBe(50);
    for (const c of codes) {
      expect(c).toHaveLength(激活码长度);
      // 0 O 1 I 8 这些打电话会念混的一个都不能出现
      expect(c).not.toMatch(/[0O1I8]/);
    }
  });

  it("上限 100，防手滑生成一万个", async () => {
    const { 生成并入库 } = await import("@/lib/tenant/activation");
    expect((await 生成并入库(5000)).length).toBe(100);
  });
});

describe("输入归一化", () => {
  it("小写、带横线、带空格都认；位数不对不认", async () => {
    const { 归一化, 展示 } = await import("@/lib/tenant/activation");
    expect(归一化("ab3d-ef5g-hj7k")).toBe("AB3DEF5GHJ7K");
    expect(归一化(" AB3D EF5G HJ7K ")).toBe("AB3DEF5GHJ7K");
    expect(归一化("AB3D-EF5G")).toBeNull();
    expect(归一化("AB3D-EF5G-HJ70")).toBeNull(); // 0 不在字母表里
    expect(展示("AB3DEF5GHJ7K")).toBe("AB3D-EF5G-HJ7K");
  });
});

describe("一码一用", () => {
  it("用过的码第二次必须失败", async () => {
    const { 生成并入库, 占用 } = await import("@/lib/tenant/activation");
    const [code] = await 生成并入库(1);
    expect((await 占用(code, "a1")).ok).toBe(true);
    const 再来 = await 占用(code, "a2");
    expect(再来.ok).toBe(false);
    if (!再来.ok) expect(再来.error).toContain("已被使用");
  });

  it("并发提交同一个码，只有一个能成", async () => {
    const { 生成并入库, 占用 } = await import("@/lib/tenant/activation");
    const [code] = await 生成并入库(1);
    const 结果 = await Promise.all(Array.from({ length: 10 }, (_, i) => 占用(code, `a${i}`)));
    expect(结果.filter((r) => r.ok).length).toBe(1);
  });

  it("编出来的码不认，而且错误信息不泄露是「不存在」还是「已用」", async () => {
    const { 占用 } = await import("@/lib/tenant/activation");
    const r = await 占用("ZZZZ-ZZZZ-ZZZZ", "a1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("激活码无效或已被使用");
  });

  it("开号失败释放后，同一个码能再用", async () => {
    const { 生成并入库, 占用, 释放 } = await import("@/lib/tenant/activation");
    const [code] = await 生成并入库(1);
    await 占用(code, "a1");
    await 释放(code);
    expect((await 占用(code, "a1")).ok).toBe(true);
  });
});

describe("运营台", () => {
  it("生成要验 token——不验就等于任何人都能给自己发码", async () => {
    const { generateCodes } = await import("@/app/admin/actions");
    expect((await generateCodes({ token: "", count: 3 })).ok).toBe(false);
    expect((await generateCodes({ token: "猜的", count: 3 })).ok).toBe(false);
    const r = await generateCodes({ token: "t-admin", count: 3, note: "给张老师" });
    expect(r.ok && r.codes.length).toBe(3);
    if (r.ok) expect(r.codes[0]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });
});
