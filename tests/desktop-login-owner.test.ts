/**
 * 桌面端登录当场记下目录归属（lib/desktop/cloud.ts 登录，2026-10-02 排查桌面端 A2）。
 *
 * 原来要等「带着令牌重启」才记：第一次装好、甲登录录了客户、退出，乙再登录——目录还是没主的，
 * 判「没换人」，乙直接进了甲的库。现在甲一登录就记上；乙登录时 换了账号=true，壳据此换目录。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDb } from "./reset";

// 桌面端登录 成功那一支要建会话（auth.ts 顶层 import next/headers），vitest 里没有请求上下文
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

let 目录: string;
beforeEach(async () => {
  /*
    先清库（2026-10-04）：A-2 的修法让「没主的目录」登录时比对库里管理员的邮箱。测试库是全套共用的，
    前面的文件留下一个带邮箱的管理员，甲登录就会被（正确地）判成「换了人」——这里要的是一个从没登录过的新库
  */
  await resetDb();
  目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-login-owner-"));
  process.env.DESKTOP_LOCAL = "1";
  process.env.CRM_DATA_DIR = 目录;
  process.env.CRM_CLOUD_URL = "http://cloud.test";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DESKTOP_LOCAL;
  delete process.env.CRM_DATA_DIR;
  delete process.env.CRM_CLOUD_URL;
  fs.rmSync(目录, { recursive: true, force: true });
});

const 云端是 = (accountId: string) =>
  vi.stubGlobal("fetch", async (url: string) => {
    const body = String(url).endsWith("/api/account/token")
      ? { token: `t-${accountId}`, account: { id: accountId, name: accountId, contact: `${accountId}@x.com` }, credits: { 还剩: 30 } }
      : { data: [{ id: "deepseek-v4.1-flash" }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });

describe("登录当场记归属", () => {
  it("没主的目录：甲登录就归甲；甲退出后乙登录，认得出换了人", async () => {
    const { 登录 } = await import("@/lib/desktop/cloud");
    云端是("acc_甲");
    const 甲 = await 登录("甲@x.com", "pw");
    expect(甲.ok && 甲.data.换了账号).toBe(false);
    expect(fs.readFileSync(path.join(目录, ".owner"), "utf8")).toBe("acc_甲");

    fs.rmSync(path.join(目录, ".cloud.json")); // 甲退出登录
    云端是("acc_乙");
    const 乙 = await 登录("乙@x.com", "pw");
    expect(乙.ok && 乙.data.换了账号).toBe(true);
    // 归属不被乙改掉：这份还是甲的
    expect(fs.readFileSync(path.join(目录, ".owner"), "utf8")).toBe("acc_甲");
  });
});

describe("换了人登录：一个字都不往上一个人的库里写（回归核对 D-019）", () => {
  it("甲登录过、退出；乙在甲的目录上点登录：桌面端登录 回「换账号」，库里管理员还是甲的名字邮箱", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { 桌面端登录 } = await import("@/app/login/actions");
    // 模板库带的那个管理员（种子邮箱 admin）
    await prisma.user.create({ data: { email: "admin", name: "管理员", password: "x", role: "ADMIN", title: "系统管理员" } });

    云端是("acc_甲");
    const 甲 = await 桌面端登录("acc_甲@x.com", "pw");
    expect(甲).toEqual({ ok: true });
    const 甲之后 = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
    expect({ email: 甲之后.email, name: 甲之后.name }).toEqual({ email: "acc_甲@x.com", name: "acc_甲" });

    fs.rmSync(path.join(目录, ".cloud.json")); // 甲退出登录
    云端是("acc_乙");
    const 乙 = await 桌面端登录("acc_乙@x.com", "pw");
    expect(乙).toEqual({ ok: true, 换账号: true });
    // 这会儿连着的还是甲的库：乙的名字、邮箱一个都不许写进来，也不许多出一个人
    const 人们 = await prisma.user.findMany({ select: { email: true, name: true, title: true } });
    expect(人们).toEqual([{ email: "acc_甲@x.com", name: "acc_甲", title: "管理员" }]);
  });
});
