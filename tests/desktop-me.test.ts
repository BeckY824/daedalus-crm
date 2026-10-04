/**
 * 本机我()（src/lib/desktop/me.ts）：这台电脑上的「我」是哪个 User。
 * T-014（2026-10-04 上线前回归核对）：进了团队，同事的账号也同步进来、也是管理员，而且常常建得比我早——
 * 再按「第一个在职管理员」取，自动登录、Dock 提醒、团队身份都会落到同事头上。四处调用都没有测试，这里钉住：
 * 有 .cloud.json 就认 acct_<云端账号>，没有（一个人用、没登录云端）才退回第一个管理员。
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 本机我, 团队身份id } from "@/lib/desktop/me";

const 目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-desktop-me-"));
const 凭据 = path.join(目录, ".cloud.json");
const 原 = { dir: process.env.CRM_DATA_DIR, local: process.env.DESKTOP_LOCAL };

let 同事: string;
let 我: string;

beforeAll(() => {
  process.env.CRM_DATA_DIR = 目录;
  process.env.DESKTOP_LOCAL = "1";
});

beforeEach(async () => {
  await resetDb();
  fs.rmSync(凭据, { force: true });
  // 同事的账号先同步进来（createdAt 更早），两个都是在职管理员
  同事 = (await prisma.user.create({ data: { id: 团队身份id("colleague"), email: "c@x", name: "同事", role: "ADMIN", password: "x", createdAt: new Date("2026-09-01T00:00:00Z") } })).id;
  我 = (await prisma.user.create({ data: { id: 团队身份id("me"), email: "me@x", name: "我", role: "ADMIN", password: "x", createdAt: new Date("2026-10-01T00:00:00Z") } })).id;
});

afterAll(async () => {
  if (原.dir === undefined) delete process.env.CRM_DATA_DIR; else process.env.CRM_DATA_DIR = 原.dir;
  if (原.local === undefined) delete process.env.DESKTOP_LOCAL; else process.env.DESKTOP_LOCAL = 原.local;
  fs.rmSync(目录, { recursive: true, force: true });
  await prisma.$disconnect();
});

const 登录云端 = (accountId: string) =>
  fs.writeFileSync(凭据, JSON.stringify({ baseUrl: "http://fake", token: "dk_test", accountId, name: "我", contact: "me@x", models: [], loggedAt: new Date().toISOString() }));

describe("本机我()（T-014）", () => {
  it("两个在职管理员、同事建得更早，.cloud.json 指向我 → 是我", async () => {
    登录云端("me");
    expect(await 本机我(prisma)).toEqual({ id: 我 });
  });

  it("没有 .cloud.json（一个人用）→ 退回第一个在职管理员", async () => {
    expect(await 本机我(prisma)).toEqual({ id: 同事 });
  });

  it(".cloud.json 指向的账号在本机库里没有 / 停用了 → 退回第一个在职管理员", async () => {
    登录云端("nobody");
    expect(await 本机我(prisma)).toEqual({ id: 同事 });
    登录云端("me");
    await prisma.user.update({ where: { id: 我 }, data: { active: false } });
    expect(await 本机我(prisma)).toEqual({ id: 同事 });
  });
});
