import { closeTestDatabases } from "./close-databases";
/**
 * 每日赠送只发注册后的前 30 天（2026-09-28 用户拍板）。规则在 lib/tenant/credits.ts。
 *
 * 钉的是四件事：边界（第 30 天发、第 31 天不发）；只加不减；注册赠送和网页版工作区不受波及；
 * 以及对外说的话跟着变——过了期还说「每天登录再送 3 次」「明天再送」就是许诺一个不再发的东西。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";


const 临时根 = path.join(os.tmpdir(), `crm-daily-window-${process.pid}`);

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  process.env.MULTI_TENANT = "1";
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时根, "control.db")}`;
  const sql = execFileSync(
    process.execPath,
    [path.resolve("node_modules/prisma/build/index.js"), "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"],
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

afterAll(async () => {
  delete process.env.MULTI_TENANT;
  await closeTestDatabases(临时根);
  fs.rmSync(临时根, { recursive: true, force: true });
});

beforeEach(async () => {
  const { control } = await import("@/lib/tenant/control");
  await control.machineSignup.deleteMany({});
  await control.accountAiGrant.deleteMany({});
  await control.accountAiUsage.deleteMany({});
  await control.aiGrant.deleteMany({});
  await control.aiUsage.deleteMany({});
  const { 重置限流 } = await import("@/lib/rate-limit");
  重置限流();
});


let 序号 = 0;
const 天 = 86_400_000;
const 电脑 = (名: string) => createHash("sha256").update(`测试机器:${名}`).digest("hex");

/** 建一个「注册了 n 天前」的账号：注册当天 n = 0，是第 1 天 */
async function 注册于(n天前: number) {
  const { createAccount } = await import("@/lib/tenant/accounts");
  const { control } = await import("@/lib/tenant/control");
  const a = await createAccount({
    target: { kind: "phone", value: `1380000${String(序号++).padStart(4, "0")}` },
    password: "abcd1234",
    name: "桌面用户",
  });
  await control.account.update({ where: { id: a.id }, data: { createdAt: new Date(Date.now() - n天前 * 天) } });
  return a;
}

const 账号 = (id: string) => ({ kind: "account" as const, id });

const 每日条数 = async (accountId: string) => {
  const { control } = await import("@/lib/tenant/control");
  return control.accountAiGrant.count({ where: { accountId, reason: "daily" } });
};

async function 登录(手机号: string, 机器?: string) {
  const { POST } = await import("@/app/api/account/token/route");
  const res = await POST(new Request("https://app.example.com/api/account/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify({ target: 手机号, password: "abcd1234", name: "某台机器", ...(机器 ? { machine: 机器 } : {}) }),
  }));
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string };
}

function 开网关() {
  process.env.GATEWAY_API_KEY = "upstream-key";
  process.env.GATEWAY_BASE_URL = "https://relay.example.com/v1";
  process.env.GATEWAY_MODELS = "deepseek-chat";
}
function 关网关() {
  delete process.env.GATEWAY_API_KEY;
  delete process.env.GATEWAY_BASE_URL;
  delete process.env.GATEWAY_MODELS;
}

describe("每日赠送只发注册后的前 30 天（2026-09-28 拍板）", () => {
  it("注册后第 30 天那天照发", async () => {
    const { 结算赠送 } = await import("@/lib/tenant/credits");
    const a = await 注册于(29);
    await 结算赠送(账号(a.id));
    expect(await 每日条数(a.id)).toBe(1);
  });

  it("第 31 天起不再发", async () => {
    const { 结算赠送, 余额 } = await import("@/lib/tenant/credits");
    const a = await 注册于(30);
    await 结算赠送(账号(a.id));
    expect(await 每日条数(a.id)).toBe(0);
    expect((await 余额(账号(a.id))).上限).toBe(0);
  });

  it("只加不减：期内领到的每日赠送，过了期一条都不收回", async () => {
    const { 赠送, 结算赠送, 余额 } = await import("@/lib/tenant/credits");
    const a = await 注册于(45);
    await 赠送(账号(a.id), { amount: 3, reason: "daily", key: `${a.id}:daily:2026-08-20` });
    await 结算赠送(账号(a.id));
    expect((await 余额(账号(a.id))).上限).toBe(3);
  });

  it("注册赠送不受这个窗口影响：第 40 天第一次在新电脑上登录，那 30 次照样到账", async () => {
    const { 余额, 注册赠送 } = await import("@/lib/tenant/credits");
    const a = await 注册于(40);
    await 登录(a.phone!, 电脑("第四十天才装"));
    expect((await 余额(账号(a.id))).上限).toBe(注册赠送);
    expect(await 每日条数(a.id)).toBe(0);
  });

  it("网页版工作区不设窗口：共享工作区整个靠每日赠送续命，建了 100 天照发", async () => {
    const { control } = await import("@/lib/tenant/control");
    const { 结算赠送 } = await import("@/lib/tenant/credits");
    const id = `ws-old-${序号++}`;
    await control.workspace.create({
      data: { id, slug: id, name: id, dbFile: `${id}.db`, status: "TRIAL", trialEndsAt: new Date(Date.now() + 3650 * 天), createdAt: new Date(Date.now() - 100 * 天) },
    });
    await control.aiUsage.create({ data: { workspaceId: id, calls: 30 } });
    await 结算赠送({ kind: "workspace", id });
    expect(await control.aiGrant.count({ where: { workspaceId: id, reason: "daily" } })).toBe(1);
  });

  it("余额接口：期内报 3 次和截至日；过了期报 0——老版本桌面端只认这个数，是 0 就不许诺", async () => {
    const { GET } = await import("@/app/api/gateway/v1/credits/route");
    const { 每日赠送, 今天 } = await import("@/lib/tenant/credits");
    开网关();
    try {
      const 查 = async (token: string) =>
        (await (await GET(new Request("https://app.example.com/api/gateway/v1/credits", { headers: { Authorization: `Bearer ${token}` } }))).json()) as {
          每日赠送?: number;
          每日赠送截至?: string | null;
        };
      const 新 = await 注册于(0);
      const 新的 = await 查((await 登录(新.phone!)).token);
      expect(新的.每日赠送).toBe(每日赠送);
      // 注册当天是第 1 天，第 30 天是往后数 29 天
      const 应截至 = new Date(Date.parse(`${今天()}T00:00:00Z`) + 29 * 天).toISOString().slice(0, 10);
      expect(新的.每日赠送截至).toBe(应截至);

      const 老 = await 注册于(31);
      const 老的 = await 查((await 登录(老.phone!)).token);
      expect(老的.每日赠送, "过了期还报 3，老客户端就会继续说「每天登录再送 3 次」").toBe(0);
      expect(Boolean(老的.每日赠送截至 && 老的.每日赠送截至 < 今天())).toBe(true);
    } finally {
      关网关();
    }
  });

  it("次数用完时那句话：期内说明天再送，过了期不开空头支票", async () => {
    const { POST } = await import("@/app/api/gateway/v1/chat/completions/route");
    const { control } = await import("@/lib/tenant/control");
    开网关();
    try {
      const 问 = async (token: string) => {
        const res = await POST(new Request("https://app.example.com/api/gateway/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "你好" }] }),
        }));
        expect(res.status).toBe(402);
        return JSON.stringify(await res.json());
      };

      const 期内 = await 注册于(3);
      const t1 = (await 登录(期内.phone!)).token;
      await control.accountAiUsage.upsert({ where: { accountId: 期内.id }, create: { accountId: 期内.id, calls: 99 }, update: { calls: 99 } });
      expect(await 问(t1)).toContain("明天登录再送");

      const 过期 = await 注册于(60);
      const t2 = (await 登录(过期.phone!)).token;
      const 话 = await 问(t2);
      expect(话).not.toContain("明天登录再送");
      expect(话).toContain("每日赠送也已经结束");
      expect(话, "BYOK 那条出路要一直说").toContain("API Key");
    } finally {
      关网关();
    }
  });
});
