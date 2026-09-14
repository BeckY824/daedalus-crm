/**
 * 演示码与万能邀请码。
 *
 * 演示码要钉的是「一码一人」在并发下也成立，以及 5 次 AI 的扣减是原子的——
 * 演示区是所有访客共用一个工作区，这两条要是漏了，就是"所有人共用、不限次"的账单黑洞。
 * 万能码要钉的是「换了旧码立刻作废」。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-democode-${process.pid}`);

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  process.env.MULTI_TENANT = "1";
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时根, "control.db")}`;
  const sql = execFileSync("npx", ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(临时根, "c.sql"), sql);
  execFileSync("node", ["--experimental-sqlite", "-e", `
    const { DatabaseSync } = require('node:sqlite'); const fs = require('node:fs');
    const db = new DatabaseSync(process.argv[1]); db.exec(fs.readFileSync(process.argv[2], 'utf8')); db.close();
  `, path.join(临时根, "control.db"), path.join(临时根, "c.sql")], { stdio: "pipe" });
});
afterAll(() => { delete process.env.MULTI_TENANT; fs.rmSync(临时根, { recursive: true, force: true }); });
beforeEach(async () => {
  const { control } = await import("@/lib/tenant/control");
  await control.demoCode.deleteMany({});
  await control.trialMasterCode.deleteMany({});
});

describe("演示码", () => {
  it("绑到第一个来的浏览器；同一个浏览器重复进算成功；别的浏览器拒", async () => {
    const { 生成演示码, 绑定演示码 } = await import("@/lib/tenant/activation");
    const [code] = await 生成演示码(1);
    expect((await 绑定演示码(code, "browser-a")).ok).toBe(true);
    // 刷新页面、重新进入都不该把人拦在外面
    expect((await 绑定演示码(code.toLowerCase(), "browser-a")).ok).toBe(true);
    const 别人 = await 绑定演示码(code, "browser-b");
    expect(别人.ok).toBe(false);
    if (!别人.ok) expect(别人.error).toContain("别的浏览器");
  });

  it("并发抢同一个码，只有一个浏览器绑上", async () => {
    const { 生成演示码, 绑定演示码 } = await import("@/lib/tenant/activation");
    const [code] = await 生成演示码(1);
    const 结果 = await Promise.all(Array.from({ length: 10 }, (_, i) => 绑定演示码(code, `b${i}`)));
    expect(结果.filter((r) => r.ok)).toHaveLength(1);
  });

  it("5 次 AI，第 6 次拦下；并发也不多放行", async () => {
    const { 生成演示码, 绑定演示码, 演示码扣一次, 演示码剩余, 演示对话上限 } = await import("@/lib/tenant/activation");
    const [code] = await 生成演示码(1);
    await 绑定演示码(code, "v1");
    const 结果 = await Promise.all(Array.from({ length: 12 }, () => 演示码扣一次("v1")));
    expect(结果.filter((r) => r.ok)).toHaveLength(演示对话上限);
    const 剩 = await 演示码剩余("v1");
    expect(剩?.还剩).toBe(0);
    // 对外的用掉数夹回上限，不显示「已用 12 / 5」
    expect(剩?.用掉).toBe(演示对话上限);
  });

  it("没绑过码的访客扣不了", async () => {
    const { 演示码扣一次, 演示码剩余 } = await import("@/lib/tenant/activation");
    expect((await 演示码扣一次("nobody")).ok).toBe(false);
    expect(await 演示码剩余("nobody")).toBeNull();
  });

  it("编出来的码不认", async () => {
    const { 绑定演示码 } = await import("@/lib/tenant/activation");
    expect((await 绑定演示码("ABCD-EFGH-JKLM", "x")).ok).toBe(false);
    expect((await 绑定演示码("short", "x")).ok).toBe(false);
  });
});

describe("万能邀请码", () => {
  it("没生成过时什么都不认", async () => {
    const { 核验万能码, 取万能码 } = await import("@/lib/tenant/activation");
    expect(await 取万能码()).toBeNull();
    expect(await 核验万能码("ABCD-EFGH-JKLM")).toBe(false);
  });

  it("生成后认（大小写、横线都行），换了旧码立刻作废、只有一行", async () => {
    const { 换万能码, 核验万能码, 展示, 取万能码 } = await import("@/lib/tenant/activation");
    const { control } = await import("@/lib/tenant/control");
    const 旧 = await 换万能码();
    expect(await 核验万能码(展示(旧).toLowerCase())).toBe(true);
    const 新 = await 换万能码();
    expect(新).not.toBe(旧);
    expect(await 核验万能码(旧)).toBe(false);
    expect(await 核验万能码(新)).toBe(true);
    expect(await 取万能码()).toBe(新);
    expect(await control.trialMasterCode.count()).toBe(1);
  });
});
