import { closeTestDatabases } from "./close-databases";
/**
 * 不再有每日赠送（2026-10-03 用户：「只送注册账号的 30 次。目前已有的账户也不再赠送了」）。规则在 lib/tenant/credits.ts。
 * 前身是 daily-window.test.ts（09-28「只发注册后 30 天」那一版），搭库和造账号的办法照旧。
 *
 * 钉的是：新号、老号、期内、过期、用完了，一律不再补；以前发出去的一条都不收回；开户赠送照常一台电脑一份；
 * 对外说的话跟着变——还说「每天登录再送 3 次」「明天再送」就是许诺一个不再发的东西。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";


const 临时根 = path.join(os.tmpdir(), `crm-no-daily-${process.pid}`);

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

/**
 * 10-03 起每日赠送只发给领到了开户赠送的账号（一台电脑一份）。验「窗口」这件事的用例
 * 先让账号在自己那台电脑上领到那 30 次、再全用掉——余额低于门槛，每日赠送才轮得到它
 */
async function 领过开户并用完(a: { id: string; phone: string | null }, 机器名: string) {
  const { control } = await import("@/lib/tenant/control");
  await 登录(a.phone!, 电脑(机器名));
  await control.accountAiUsage.upsert({ where: { accountId: a.id }, create: { accountId: a.id, calls: 30 }, update: { calls: 30 } });
}

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

describe("不再有每日赠送", () => {
  it("刚注册、注册二十天、注册六十天：用完了一律不补", async () => {
    const { 结算赠送, 余额, 注册赠送 } = await import("@/lib/tenant/credits");
    for (const [n, 名] of [[0, "新号"], [20, "二十天"], [60, "六十天"]] as const) {
      const a = await 注册于(n);
      await 领过开户并用完(a, 名);
      await 结算赠送(账号(a.id));
      expect(await 每日条数(a.id), `${名}：不该再有每日赠送`).toBe(0);
      expect((await 余额(账号(a.id))).上限).toBe(注册赠送);
    }
  });

  it("以前发出去的每日赠送一条都不收回：只加不减", async () => {
    const { 赠送, 结算赠送, 余额 } = await import("@/lib/tenant/credits");
    const a = await 注册于(45);
    await 赠送(账号(a.id), { amount: 3, reason: "daily", key: `${a.id}:daily:2026-08-20` });
    await 结算赠送(账号(a.id));
    expect((await 余额(账号(a.id))).上限).toBe(3);
  });

  it("开户赠送照常：第 40 天第一次在新电脑上登录，那 30 次照样到账", async () => {
    const { 余额, 注册赠送 } = await import("@/lib/tenant/credits");
    const a = await 注册于(40);
    await 登录(a.phone!, 电脑("第四十天才装"));
    expect((await 余额(账号(a.id))).上限).toBe(注册赠送);
    expect(await 每日条数(a.id)).toBe(0);
  });

  it("网页版工作区（含共享试用工作区）也不再每天送：建了 100 天、用光了也不补", async () => {
    const { control } = await import("@/lib/tenant/control");
    const { 结算赠送 } = await import("@/lib/tenant/credits");
    const id = `ws-old-${序号++}`;
    await control.workspace.create({
      data: { id, slug: id, name: id, dbFile: `${id}.db`, status: "TRIAL", trialEndsAt: new Date(Date.now() + 3650 * 天), createdAt: new Date(Date.now() - 100 * 天) },
    });
    await control.aiUsage.create({ data: { workspaceId: id, calls: 30 } });
    await 结算赠送({ kind: "workspace", id });
    expect(await control.aiGrant.count({ where: { workspaceId: id, reason: "daily" } })).toBe(0);
  });

  it("余额接口：每日赠送恒报 0、截至恒报 null——老版本桌面端只认这个数，是 0 就不许诺", async () => {
    const { GET } = await import("@/app/api/gateway/v1/credits/route");
    开网关();
    try {
      const 查 = async (token: string) =>
        (await (await GET(new Request("https://app.example.com/api/gateway/v1/credits", { headers: { Authorization: `Bearer ${token}` } }))).json()) as {
          每日赠送?: number;
          每日赠送截至?: string | null;
        };
      for (const [n, 名] of [[0, "新来的"], [31, "老用户"]] as const) {
        const a = await 注册于(n);
        const r = await 查((await 登录(a.phone!, 电脑(名))).token);
        expect(r.每日赠送, 名).toBe(0);
        expect(r.每日赠送截至, 名).toBeNull();
      }
    } finally {
      关网关();
    }
  });

  it("次数用完时那句话：不说「明天再送」，要给出填 Key 的出路；没领到开户赠送的要说清楚为什么", async () => {
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

      const 甲 = await 注册于(3);
      const t1 = (await 登录(甲.phone!, 电脑("甲那台"))).token;
      await control.accountAiUsage.upsert({ where: { accountId: 甲.id }, create: { accountId: 甲.id, calls: 99 }, update: { calls: 99 } });
      const 话 = await 问(t1);
      expect(话).not.toContain("明天");
      expect(话, "BYOK 那条出路要一直说").toContain("API Key");

      const 乙 = await 注册于(3);
      const 话2 = await 问((await 登录(乙.phone!, 电脑("甲那台"))).token);
      expect(话2).not.toContain("明天");
      expect(话2).toContain("一台电脑只送一份");
    } finally {
      关网关();
    }
  });
});
