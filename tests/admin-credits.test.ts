import { closeTestDatabases } from "./close-databases";
/**
 * 运营台手动加次数（lib/tenant/admin-credits.ts + 运营台动作 给账号加次数，2026-10-19）。用户原话：
 * 「如果有用户和我购买了次数，我可以手动添加。包括AI次数……团队版……我可以直接增加背调次数+AI次数。个人版就单独做一个页面做这个。」
 *
 * 钉这几件事：
 *   1. 个人加背调 / 加 AI：加上了，桌面端读的两个接口（/credits、/research/price）下一次就是新数（服务器不缓存）
 *   2. 同一次点击只加一次：同一个编号重发、并发连点，都只多一笔；编号换了种类不算数
 *   3. 只加不减、一次 1–1000 的整数，超出就拒；测试账号拒（不限次数）；账号不存在拒
 *   4. 团队成员：在团队里才加得上，退出的不行；记录里带团队；团队详情列出角色、设备数、两种余额
 *   5. 每次都留记录：谁（口令 / 运营账号）、几次、备注；10-19 之前加的老记录照样列出来，「谁」是空
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-admin-credits-${process.pid}`);
const TOKEN = "ops-token-admin-credits";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  process.env.MULTI_TENANT = "1";
  process.env.ADMIN_TOKEN = TOKEN;
  // 桌面端读余额走网关：要有网关配置才认令牌（上游不会被调到，这里只读余额）
  process.env.GATEWAY_API_KEY = "upstream-key-admin-credits";
  process.env.GATEWAY_BASE_URL = "https://upstream.example.com/v1";
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
  delete process.env.ADMIN_TOKEN;
  delete process.env.OPS_ACCOUNTS;
  delete process.env.TEST_ACCOUNTS;
  delete process.env.GATEWAY_API_KEY;
  delete process.env.GATEWAY_BASE_URL;
  await closeTestDatabases(临时根);
  fs.rmSync(临时根, { recursive: true, force: true });
});

beforeEach(async () => {
  delete process.env.OPS_ACCOUNTS;
  delete process.env.TEST_ACCOUNTS;
  const { control } = await import("@/lib/tenant/control");
  for (const t of ["adminCreditLog", "accountAiGrant", "researchGrant", "accountAiUsage", "aiResearchRun", "testAccount", "syncMember", "syncDevice", "syncTeam", "machineSignup", "deviceInfo", "deviceToken", "account"] as const) {
    await (control[t] as unknown as { deleteMany: (a: object) => Promise<unknown> }).deleteMany({});
  }
  const { 重置限流 } = await import("@/lib/rate-limit");
  重置限流();
});

let 序号 = 0;
let 点 = 0;
const 编号 = () => `click${Date.now().toString(36)}${++点}`;

async function 建账号(name = "买了次数的客户", email?: string) {
  const { createAccount } = await import("@/lib/tenant/accounts");
  return createAccount({
    target: email ? { kind: "email", value: email } : { kind: "phone", value: `1370000${String(序号++).padStart(4, "0")}` },
    password: "abcd1234",
    name,
  });
}

/** 桌面端登录拿令牌（同一条路：/api/account/token） */
async function 登录(target: string) {
  const { POST } = await import("@/app/api/account/token/route");
  const res = await POST(new Request("https://app.example.com/api/account/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": `203.0.113.${序号 % 200}` },
    body: JSON.stringify({ target, password: "abcd1234", name: "客户的电脑" }),
  }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

const 桌面端读AI = async (token: string) => {
  const { GET } = await import("@/app/api/gateway/v1/credits/route");
  return ((await (await GET(new Request("https://app.example.com/api/gateway/v1/credits", { headers: { Authorization: `Bearer ${token}` } }))).json()) as { 还剩: number }).还剩;
};
const 桌面端读背调 = async (token: string) => {
  const { GET } = await import("@/app/api/gateway/v1/research/price/route");
  return ((await (await GET(new Request("https://app.example.com/api/gateway/v1/research/price", { headers: { Authorization: `Bearer ${token}` } }))).json()) as { 还剩: number }).还剩;
};

async function 加(input: { accountId: string; 种类: "research" | "ai"; n: number; key?: string; note?: string; teamId?: string; token?: string }) {
  const { 给账号加次数 } = await import("@/app/admin/actions");
  return 给账号加次数({ token: input.token ?? TOKEN, key: input.key ?? 编号(), ...input });
}

describe("个人加次数", () => {
  it("加背调：背调余额 +N，桌面端问价马上看到；记录里有谁、几次、备注", async () => {
    const a = await 建账号("王老板", "wang@buyer.test");
    const t = await 登录("wang@buyer.test");
    const 前 = await 桌面端读背调(t);
    expect(await 加({ accountId: a.id, 种类: "research", n: 10, note: "微信转账 10 次" })).toEqual({ ok: true, 重复: false });
    expect(await 桌面端读背调(t)).toBe(前 + 10);
    const { 背调余额 } = await import("@/lib/tenant/credits");
    expect((await 背调余额({ kind: "account", id: a.id })).还剩).toBe(前 + 10);

    const { 加次记录 } = await import("@/lib/tenant/admin-credits");
    const [r] = await 加次记录();
    expect(r).toMatchObject({ accountId: a.id, 种类: "research", 数: 10, by: "口令", note: "微信转账 10 次", 团队: null });
    expect(r.账号).toContain("wang@buyer.test");
  });

  it("加 AI：AI 余额 +N，桌面端 /credits 马上是新数（不碰背调次数）", async () => {
    const a = await 建账号("李经理", "li@buyer.test");
    const t = await 登录("li@buyer.test");
    const [AI前, 背调前] = [await 桌面端读AI(t), await 桌面端读背调(t)];
    expect((await 加({ accountId: a.id, 种类: "ai", n: 200, note: "支付宝 200 次" })).ok).toBe(true);
    expect(await 桌面端读AI(t)).toBe(AI前 + 200);
    expect(await 桌面端读背调(t)).toBe(背调前);
    const { control } = await import("@/lib/tenant/control");
    const g = await control.accountAiGrant.findFirst({ where: { accountId: a.id, reason: "admin" } });
    expect(g).toMatchObject({ amount: 200, note: "支付宝 200 次" });
    expect(g!.key).toMatch(/^admin:/);
  });

  it("没写备注：赠送那一行记「运营台」，记录那一行备注是空", async () => {
    const a = await 建账号();
    await 加({ accountId: a.id, 种类: "ai", n: 3 });
    const { control } = await import("@/lib/tenant/control");
    expect((await control.accountAiGrant.findFirst({ where: { accountId: a.id } }))!.note).toBe("运营台");
    expect((await control.adminCreditLog.findFirst({ where: { accountId: a.id } }))!.note).toBeNull();
  });
});

describe("同一次点击只加一次", () => {
  it("同一个编号重发：第二次回「已经加过」，余额和记录都只多一笔", async () => {
    const a = await 建账号();
    const key = 编号();
    expect(await 加({ accountId: a.id, 种类: "research", n: 5, key })).toEqual({ ok: true, 重复: false });
    expect(await 加({ accountId: a.id, 种类: "research", n: 5, key })).toEqual({ ok: true, 重复: true });
    const { control } = await import("@/lib/tenant/control");
    expect((await control.researchGrant.aggregate({ where: { accountId: a.id, reason: "admin" }, _sum: { amount: true } }))._sum.amount).toBe(5);
    expect(await control.adminCreditLog.count({ where: { accountId: a.id } })).toBe(1);
  });

  it("连点（同一个编号并发 5 下）：只加 1 次", async () => {
    const a = await 建账号();
    const key = 编号();
    const 结果 = await Promise.all(Array.from({ length: 5 }, () => 加({ accountId: a.id, 种类: "ai", n: 7, key })));
    expect(结果.every((r) => r.ok)).toBe(true);
    expect(结果.filter((r) => r.ok && !r.重复)).toHaveLength(1);
    const { control } = await import("@/lib/tenant/control");
    expect((await control.accountAiGrant.aggregate({ where: { accountId: a.id, reason: "admin" }, _sum: { amount: true } }))._sum.amount).toBe(7);
    expect(await control.adminCreditLog.count()).toBe(1);
  });

  it("同一个编号拿去加另一种次数 / 另一个人：拒，什么都不多（整笔回滚，不会只多一半）", async () => {
    const [a, b] = [await 建账号(), await 建账号()];
    const key = 编号();
    await 加({ accountId: a.id, 种类: "research", n: 5, key });
    expect((await 加({ accountId: a.id, 种类: "ai", n: 5, key })).ok).toBe(false);
    expect((await 加({ accountId: b.id, 种类: "research", n: 5, key })).ok).toBe(false);
    const { control } = await import("@/lib/tenant/control");
    expect(await control.accountAiGrant.count({ where: { reason: "admin" } })).toBe(0);
    expect(await control.researchGrant.count({ where: { reason: "admin" } })).toBe(1);
    expect(await control.adminCreditLog.count()).toBe(1);
  });

  it("两次不同的点击（编号不同）各加各的", async () => {
    const a = await 建账号();
    await 加({ accountId: a.id, 种类: "research", n: 2 });
    await 加({ accountId: a.id, 种类: "research", n: 3 });
    const { 余额们 } = await import("@/lib/tenant/admin-credits");
    expect((await 余额们([a.id])).get(a.id)!.背调.送).toBe(5);
  });
});

describe("只加不减、1–1000、该拒的拒", () => {
  it("0、负数、小数、1001、不是数：拒，什么都不加；1 和 1000 可以", async () => {
    const a = await 建账号();
    for (const n of [0, -5, 1.5, 1001, Number.NaN]) {
      const r = await 加({ accountId: a.id, 种类: "ai", n });
      expect(r, `n = ${n}`).toEqual({ ok: false, error: "一次加 1–1000 次" });
    }
    expect((await 加({ accountId: a.id, 种类: "ai", n: 1 })).ok).toBe(true);
    expect((await 加({ accountId: a.id, 种类: "ai", n: 1000 })).ok).toBe(true);
    const { 余额们 } = await import("@/lib/tenant/admin-credits");
    expect((await 余额们([a.id])).get(a.id)!.ai.送).toBe(1001);
  });

  it("没带编号 / 编号乱写：拒（防的是绕过弹框直接调动作、每次不带编号就能重复加）", async () => {
    const a = await 建账号();
    for (const key of ["", "短", "has space in it", "x".repeat(65)]) expect((await 加({ accountId: a.id, 种类: "ai", n: 1, key })).ok, key).toBe(false);
    const { control } = await import("@/lib/tenant/control");
    expect(await control.accountAiGrant.count()).toBe(0);
  });

  it("种类乱写、口令不对、账号不存在：拒", async () => {
    const a = await 建账号();
    const { 给账号加次数 } = await import("@/app/admin/actions");
    expect((await 给账号加次数({ token: TOKEN, accountId: a.id, 种类: "money" as "ai", n: 1, key: 编号() })).ok).toBe(false);
    expect(await 加({ accountId: a.id, 种类: "ai", n: 1, token: "猜的" })).toEqual({ ok: false, error: "无权操作" });
    expect(await 加({ accountId: "没有这个人", 种类: "ai", n: 1 })).toEqual({ ok: false, error: "账号不存在" });
  });

  it("测试账号不限次数：拒，并说清楚为什么（以前是按钮藏起来，看着像「加不了」）", async () => {
    const a = await 建账号();
    const { 设测试账号 } = await import("@/lib/tenant/test-accounts");
    await 设测试账号(a.id, true, "口令");
    expect(await 加({ accountId: a.id, 种类: "research", n: 5 })).toEqual({ ok: false, error: "测试账号不限次数，不用加" });
    const { 余额们 } = await import("@/lib/tenant/admin-credits");
    expect((await 余额们([a.id])).get(a.id)!.测试).toBe(true);
  });
});

describe("团队成员加次数", () => {
  async function 建团队() {
    const { control } = await import("@/lib/tenant/control");
    const [老板, 小王, 走了的] = [await 建账号("陈老板", "boss@team.test"), await 建账号("小王", "wang@team.test"), await 建账号("老张")];
    const team = await control.syncTeam.create({ data: { name: "外贸一部", ownerAccountId: 老板.id, joinSecretHash: "x", active: true } });
    await control.syncMember.createMany({
      data: [
        { teamId: team.id, accountId: 小王.id, role: "member" },
        { teamId: team.id, accountId: 老板.id, role: "owner" },
        { teamId: team.id, accountId: 走了的.id, role: "member", leftAt: new Date() },
      ],
    });
    await control.syncDevice.createMany({
      data: [
        { teamId: team.id, device: "d1", accountId: 老板.id, pubKey: "k" },
        { teamId: team.id, device: "d2", accountId: 老板.id, pubKey: "k" },
        { teamId: team.id, device: "d3", accountId: 小王.id, pubKey: "k" },
      ],
    });
    return { team, 老板, 小王, 走了的 };
  }

  it("给成员加背调和 AI：两种都加上，记录里带团队名", async () => {
    const { team, 小王 } = await 建团队();
    expect((await 加({ accountId: 小王.id, 种类: "research", n: 20, teamId: team.id, note: "团队买的" })).ok).toBe(true);
    expect((await 加({ accountId: 小王.id, 种类: "ai", n: 300, teamId: team.id })).ok).toBe(true);
    const { 余额们, 加次记录 } = await import("@/lib/tenant/admin-credits");
    const 余 = (await 余额们([小王.id])).get(小王.id)!;
    expect(余.背调.剩).toBe(20);
    expect(余.ai.剩).toBe(300);
    const 记 = await 加次记录();
    expect(记.map((r) => [r.种类, r.数, r.团队])).toEqual([["ai", 300, "外贸一部"], ["research", 20, "外贸一部"]]);
    expect(记[1].note).toBe("团队买的");
  });

  it("不在这个团队、已经退出的：拒", async () => {
    const { team, 走了的 } = await 建团队();
    const 外人 = await 建账号();
    expect(await 加({ accountId: 外人.id, 种类: "ai", n: 1, teamId: team.id })).toEqual({ ok: false, error: "这个人不在这个团队里了" });
    expect(await 加({ accountId: 走了的.id, 种类: "ai", n: 1, teamId: team.id })).toEqual({ ok: false, error: "这个人不在这个团队里了" });
  });

  it("团队详情：只列现在的成员，建的人在前；角色、设备数、两种余额都有", async () => {
    const { team, 老板, 小王 } = await 建团队();
    await 加({ accountId: 小王.id, 种类: "research", n: 4, teamId: team.id });
    const { 团队详情 } = await import("@/lib/tenant/admin-credits");
    const d = (await 团队详情(team.id))!;
    expect(d.team.name).toBe("外贸一部");
    expect(d.rows.map((r) => [r.id, r.role, r.设备])).toEqual([[老板.id, "owner", 2], [小王.id, "member", 1]]);
    expect(d.rows[1]).toMatchObject({ email: "wang@team.test", 背调: { 送: 4, 用: 0, 剩: 4 }, 测试: false });
    expect(await 团队详情("没有这个团队")).toBeNull();
  });

  it("团队页的加次记录只看这几个成员", async () => {
    const { team, 小王 } = await 建团队();
    const 外人 = await 建账号();
    await 加({ accountId: 小王.id, 种类: "ai", n: 1, teamId: team.id });
    await 加({ accountId: 外人.id, 种类: "ai", n: 2 });
    const { 加次记录 } = await import("@/lib/tenant/admin-credits");
    expect((await 加次记录({ accountIds: [小王.id] })).map((r) => r.数)).toEqual([1]);
    expect(await 加次记录()).toHaveLength(2);
  });
});

describe("次数页的数", () => {
  it("余额们和账本（余额 / 背调余额）一个算法：用掉的扣掉、退了的不算", async () => {
    const a = await 建账号();
    await 加({ accountId: a.id, 种类: "ai", n: 10 });
    await 加({ accountId: a.id, 种类: "research", n: 3 });
    const { control } = await import("@/lib/tenant/control");
    await control.accountAiUsage.create({ data: { accountId: a.id, calls: 4 } });
    await control.aiResearchRun.createMany({
      data: [
        { ownerKind: "account", ownerId: a.id, runId: "r1", units: 1, withModel: true },
        { ownerKind: "account", ownerId: a.id, runId: "r2", units: 1, withModel: true, refunded: true },
      ],
    });
    const { 余额, 背调余额 } = await import("@/lib/tenant/credits");
    const { 余额们 } = await import("@/lib/tenant/admin-credits");
    const 我的 = (await 余额们([a.id])).get(a.id)!;
    const owner = { kind: "account" as const, id: a.id };
    expect(我的.ai).toEqual({ 送: 10, 用: 4, 剩: (await 余额(owner)).还剩 });
    expect(我的.背调).toEqual({ 送: 3, 用: 1, 剩: (await 背调余额(owner)).还剩 });
  });

  it("搜账号：邮箱（不分大小写）、名字、手机都搜得到；不填列最近注册的", async () => {
    await 建账号("Alice Zhang", "alice@buyer.test");
    await 建账号("周老师");
    const { 搜账号 } = await import("@/lib/tenant/admin-credits");
    expect((await 搜账号("ALICE")).map((r) => r.name)).toEqual(["Alice Zhang"]);
    expect((await 搜账号("周老")).map((r) => r.name)).toEqual(["周老师"]);
    expect((await 搜账号("1370000")).map((r) => r.name)).toEqual(["周老师"]);
    expect((await 搜账号("")).length).toBe(2);
    expect(await 搜账号("没有这个人")).toEqual([]);
  });

  it("10-19 之前运营台加的老记录照样列出来，「谁」是空", async () => {
    const a = await 建账号();
    const { 赠送背调 } = await import("@/lib/tenant/credits");
    await 赠送背调(a.id, { amount: 5, reason: "admin", note: "运营台" });
    await 赠送背调(a.id, { amount: 1, reason: "signup" }); // 注册送的不算运营台加的
    const { 加次记录 } = await import("@/lib/tenant/admin-credits");
    expect((await 加次记录()).map((r) => [r.数, r.by, r.note])).toEqual([[5, null, "运营台"]]);
  });
});
