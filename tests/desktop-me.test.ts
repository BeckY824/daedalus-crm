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
import { 本机我, 团队身份id, 团队里被停用 } from "@/lib/desktop/me";

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

  it(".cloud.json 指向的账号在本机库里没有（还没进团队、没改身份）→ 退回第一个在职管理员", async () => {
    登录云端("nobody");
    expect(await 本机我(prisma)).toEqual({ id: 同事 });
    expect(await 团队里被停用(prisma)).toBe(false);
  });

  it("有我这一行但被停用了（老板在团队成员里停用，同步过来）→ 没有「我」，不退回第一个管理员（那是老板 / 同事）", async () => {
    // 2026-10-08 发版前审查：原来退回第一个在职管理员——团队里那是老板那一行：自动登录成老板、启动时把老板的名字改成我的
    登录云端("me");
    await prisma.user.update({ where: { id: 我 }, data: { active: false } });
    expect(await 本机我(prisma)).toBeNull();
    expect(await 团队里被停用(prisma)).toBe(true);
  });
});

describe("server-entry 启动对名字：同一条规则（裸 SQL，读源码钉住）", () => {
  const entry = fs.readFileSync(path.resolve(__dirname, "../desktop/server-entry.js"), "utf8");
  it("有我这一行就只认它，停用了就谁也不改；没有才取第一个在职管理员", () => {
    expect(entry).toContain("SELECT id, email, name, active FROM User WHERE id = ?");
    expect(entry).toMatch(/我行\s*\?\s*\(我行\.active \? 我行 : null\)/);
    // 原来那句会在我被停用时落到老板那一行
    expect(entry).not.toContain("(id = ? OR role = 'ADMIN')");
  });
});
