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

let 目录: string;
beforeEach(() => {
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
