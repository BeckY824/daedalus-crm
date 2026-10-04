/**
 * 「AI 没开」那句话指的路得真的存在（回归核对 J-182）。
 *
 * 原来不管哪种部署都说「请管理员到『设置管理 → AI 接入』填写」：桌面端没有管理员、也没有「设置管理」，
 * 断网或登录信息坏了的人照着找半天找不到。桌面端那句改成「登录云端账号」，单测一直没钉。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";

const 原 = { DESKTOP_LOCAL: process.env.DESKTOP_LOCAL, CRM_DATA_DIR: process.env.CRM_DATA_DIR, LLM_API_KEY: process.env.LLM_API_KEY };
const 空目录 = fs.mkdtempSync(path.join(os.tmpdir(), "ai-off-copy-"));

beforeEach(async () => {
  await resetDb();
  delete process.env.LLM_API_KEY;
  (await import("@/lib/settings")).invalidateSettingsCache();
});

afterAll(async () => {
  for (const [k, v] of Object.entries(原)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(空目录, { recursive: true, force: true });
  await prisma.$disconnect();
});

describe("没有可用的 AI 配置时说什么", () => {
  it("桌面端：叫人去登录云端账号，不提「管理员」「设置管理」", async () => {
    process.env.DESKTOP_LOCAL = "1";
    process.env.CRM_DATA_DIR = 空目录; // 没有 .cloud.json = 没登录云端
    try {
      const { chatJSON } = await import("@/lib/llm");
      const e = await chatJSON("随便").catch((x: Error) => x);
      expect(e).toBeInstanceOf(Error);
      const msg = (e as Error).message;
      expect(msg).toContain("登录");
      expect(msg).not.toContain("设置管理");
      expect(msg).not.toContain("管理员");
    } finally {
      delete process.env.DESKTOP_LOCAL;
    }
  });

  // 自部署版那句还写着「设置管理 → AI 接入」：那一栏现在叫「设置 → AI 接入」（左栏、账号菜单里都没有「设置管理」了）
  it("自部署：指的路是「设置 → AI 接入」，不再说「设置管理」", async () => {
    delete process.env.DESKTOP_LOCAL;
    const { chatJSON } = await import("@/lib/llm");
    const e = await chatJSON("随便").catch((x: Error) => x);
    expect((e as Error).message).toContain("设置 → AI 接入");
    expect((e as Error).message).not.toContain("设置管理");
  });
});
