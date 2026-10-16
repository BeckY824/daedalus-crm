import { closeTestDatabases } from "./close-databases";
/**
 * AI 背调的账（lib/tenant/credits.ts 的 按背调扣 / 退背调 / 背调计一次 / 收尾背调，2026-10-16）。
 *
 * 钉的全是钱：
 *   1. 一次背调整笔扣 6（自己的模型 2），**不够就一次都不扣**
 *   2. 同一个 runId 重发 start 不重扣
 *   3. 走我们的模型的，后面带同一个编号的模型调用不再扣，步数放宽到 60——**只对背调放宽**
 *   4. 退是整笔退、只退一次；背调里某一步模型失败不按步退（否则整笔退时多退一次）
 *   5. 测试账号不扣，但有那一行（搜索 / 读页认它）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-research-ledger-${process.pid}`);

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

let 序号 = 0;
async function 建账号(送 = 30) {
  const { control } = await import("@/lib/tenant/control");
  const id = `racc${序号++}`;
  await control.account.create({ data: { id, email: `${id}@t.test`, password: "x", name: id } });
  const 账本 = await import("@/lib/tenant/credits");
  await 账本.赠送({ kind: "account", id }, { amount: 送, reason: "signup", key: `${id}:signup` });
  return { kind: "account" as const, id };
}

async function 用掉(owner: { kind: "account"; id: string }) {
  return (await import("@/lib/tenant/credits")).用掉次数(owner);
}

async function 设用量(owner: { kind: "account"; id: string }, calls: number) {
  const { control } = await import("@/lib/tenant/control");
  await control.accountAiUsage.upsert({ where: { accountId: owner.id }, create: { accountId: owner.id, calls }, update: { calls } });
}

beforeEach(async () => {
  const { control } = await import("@/lib/tenant/control");
  await control.aiResearchRun.deleteMany({});
  await control.aiCharge.deleteMany({});
  await control.accountAiUsage.deleteMany({});
  await control.accountAiGrant.deleteMany({});
  await control.testAccount.deleteMany({});
  await control.account.deleteMany({});
});

describe("开始一次背调：整笔扣", () => {
  it("走我们的模型扣 6，自己的模型扣 2", async () => {
    const { 按背调扣 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    const a = await 按背调扣(owner, "run-a", 6, true);
    expect(a).toEqual({ ok: true, 扣了: 6, 还剩: 24 });
    const b = await 按背调扣(owner, "run-b", 2, false);
    expect(b).toEqual({ ok: true, 扣了: 2, 还剩: 22 });
    expect(await 用掉(owner)).toBe(8);
  });

  it("同一个 runId 重发不重扣", async () => {
    const { 按背调扣 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    await 按背调扣(owner, "run-x", 6, true);
    const 再来 = await 按背调扣(owner, "run-x", 6, true);
    expect(再来).toEqual({ ok: true, 扣了: 0, 还剩: 24 });
    expect(await 用掉(owner)).toBe(6);
  });

  it("**不够 6 次就一次都不扣**，也不留那一行", async () => {
    const { 按背调扣 } = await import("@/lib/tenant/credits");
    const { control } = await import("@/lib/tenant/control");
    const owner = await 建账号();
    await 设用量(owner, 26);
    const r = await 按背调扣(owner, "run-poor", 6, true);
    expect(r).toEqual({ ok: false, 上限: 30 });
    expect(await 用掉(owner), "扣一半的背调跑不完，一次都不该扣").toBe(26);
    expect(await control.aiResearchRun.count()).toBe(0);
    expect(await control.aiCharge.count()).toBe(0);
    // 自己的模型只要 2 次，还剩 4 次够
    expect((await 按背调扣(owner, "run-own", 2, false)).ok).toBe(true);
    expect(await 用掉(owner)).toBe(28);
  });

  it("测试账号不扣，但有那一行（units = 0），搜索认得出", async () => {
    const { 按背调扣, 背调计一次, 设测试账号 } = { ...(await import("@/lib/tenant/credits")), ...(await import("@/lib/tenant/test-accounts")) };
    const { control } = await import("@/lib/tenant/control");
    const owner = await 建账号(0);
    await 设测试账号(owner.id, true, "测试");
    const r = await 按背调扣(owner, "run-t", 6, true);
    expect(r.ok && r.扣了).toBe(0);
    expect(await 用掉(owner)).toBe(0);
    const row = await control.aiResearchRun.findFirst({ where: { ownerId: owner.id, runId: "run-t" } });
    expect(row?.units).toBe(0);
    expect(await 背调计一次(owner, "run-t", "searches", 10)).toBe("ok");
  });
});

describe("背调里的模型调用", () => {
  it("走我们的模型：带同一个编号的模型调用不再扣", async () => {
    const { 按背调扣, 按问题扣一次 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    await 按背调扣(owner, "run-m", 6, true);
    for (let i = 0; i < 30; i++) {
      const r = await 按问题扣一次(owner, "run-m");
      expect(r.ok && r.扣了, `第 ${i + 1} 步不该扣`).toBe(false);
    }
    expect(await 用掉(owner)).toBe(6);
  });

  it("自己的模型：没有 AiCharge 那一行，拿编号走我们的网关照常扣", async () => {
    const { 按背调扣, 按问题扣一次 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    await 按背调扣(owner, "run-own", 2, false);
    const r = await 按问题扣一次(owner, "run-own");
    expect(r.ok && r.扣了).toBe(true);
    expect(await 用掉(owner)).toBe(3);
  });

  it("背调放宽到 60 步，第 61 步才当新问题再扣", async () => {
    const { 按背调扣, 按问题扣一次, 背调最多步 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    await 按背调扣(owner, "run-long", 6, true);
    for (let i = 0; i < 背调最多步; i++) await 按问题扣一次(owner, "run-long");
    expect(await 用掉(owner)).toBe(6);
    const 再来 = await 按问题扣一次(owner, "run-long");
    expect(再来.ok && 再来.扣了).toBe(true);
    expect(await 用掉(owner)).toBe(7);
  });

  it("**普通问题仍是 20 步**——放宽只认背调", async () => {
    const { 按问题扣一次, 每问最多步 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    for (let i = 0; i < 每问最多步; i++) await 按问题扣一次(owner, "q-plain");
    expect(await 用掉(owner)).toBe(1);
    expect((await 按问题扣一次(owner, "q-plain")).ok).toBe(true);
    expect(await 用掉(owner)).toBe(2);
  });

  it("退过的背调不再放宽", async () => {
    const { 按背调扣, 按问题扣一次, 退背调, 每问最多步 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    await 按背调扣(owner, "run-r", 6, true);
    await 退背调(owner, "run-r");
    expect(await 用掉(owner)).toBe(0);
    // 退过之后再拿这个编号调模型：新问题，扣 1，然后照普通问题 20 步
    for (let i = 0; i < 每问最多步; i++) await 按问题扣一次(owner, "run-r");
    expect(await 用掉(owner)).toBe(1);
    await 按问题扣一次(owner, "run-r");
    expect(await 用掉(owner)).toBe(2);
  });

  it("背调里某一步上游失败不按步退；整笔退时不多退", async () => {
    const { 按背调扣, 按问题扣一次, 退这一次, 退背调 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    await 设用量(owner, 2);
    await 按背调扣(owner, "run-f", 6, true);
    await 按问题扣一次(owner, "run-f");
    await 退这一次(owner, "run-f", true);
    expect(await 用掉(owner), "一步失败不退").toBe(8);
    // 下一步照样不扣
    const r = await 按问题扣一次(owner, "run-f");
    expect(r.ok && r.扣了).toBe(false);
    expect(await 退背调(owner, "run-f")).toBe(6);
    expect(await 用掉(owner), "整笔退完回到开始前").toBe(2);
  });
});

describe("退和收尾", () => {
  it("整笔退，只退一次；AiCharge 那行一起标成退过", async () => {
    const { 按背调扣, 退背调 } = await import("@/lib/tenant/credits");
    const { control } = await import("@/lib/tenant/control");
    const owner = await 建账号();
    await 按背调扣(owner, "run-q", 6, true);
    expect(await 退背调(owner, "run-q")).toBe(6);
    expect(await 退背调(owner, "run-q")).toBe(0);
    expect(await 用掉(owner)).toBe(0);
    const charge = await control.aiCharge.findFirst({ where: { ownerId: owner.id, requestId: "run-q" } });
    expect(charge?.refunded).toBe(true);
  });

  it("退过的 runId 再 start 是新的一笔，计数清零", async () => {
    const { 按背调扣, 退背调, 背调计一次 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    await 按背调扣(owner, "run-again", 6, true);
    await 背调计一次(owner, "run-again", "searches", 10);
    await 退背调(owner, "run-again");
    expect(await 背调计一次(owner, "run-again", "searches", 10)).toBe("退过");
    expect((await 按背调扣(owner, "run-again", 6, true)).ok).toBe(true);
    expect(await 用掉(owner)).toBe(6);
    const { control } = await import("@/lib/tenant/control");
    expect((await control.aiResearchRun.findFirst({ where: { runId: "run-again" } }))?.searches).toBe(0);
  });

  it("收尾 ok=false 退；先报出了报告、再补一句没出，不退", async () => {
    const { 按背调扣, 收尾背调 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    await 按背调扣(owner, "run-bad", 6, true);
    expect(await 收尾背调(owner, "run-bad", false)).toEqual({ 有这笔: true, 退了: 6 });
    expect(await 收尾背调(owner, "run-bad", false)).toEqual({ 有这笔: true, 退了: 0 });

    await 按背调扣(owner, "run-good", 6, true);
    expect(await 收尾背调(owner, "run-good", true)).toEqual({ 有这笔: true, 退了: 0 });
    expect(await 收尾背调(owner, "run-good", false)).toEqual({ 有这笔: true, 退了: 0 });
    expect(await 用掉(owner)).toBe(6);
    expect(await 收尾背调(owner, "nope", false)).toEqual({ 有这笔: false, 退了: 0 });
  });

  it("服务器已经交出过材料的，桌面端报「没出报告」也不退（被改过的客户端白拿搜索）", async () => {
    const { 按背调扣, 收尾背调, 背调有收获 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    await 按背调扣(owner, "run-greedy", 6, true);
    await 背调有收获(owner, "run-greedy");
    expect(await 收尾背调(owner, "run-greedy", false)).toEqual({ 有这笔: true, 退了: 0 });
    expect(await 用掉(owner)).toBe(6);
  });
});

describe("搜索 / 读页的次数闸", () => {
  it("到上限就不加了；别人的 runId 不认；过期的不认", async () => {
    const { 按背调扣, 背调计一次, 背调还一次, 背调有效期 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    const 别人 = await 建账号();
    await 按背调扣(owner, "run-c", 6, true);
    for (let i = 0; i < 3; i++) expect(await 背调计一次(owner, "run-c", "pages", 3)).toBe("ok");
    expect(await 背调计一次(owner, "run-c", "pages", 3)).toBe("超了");
    await 背调还一次(owner, "run-c", "pages");
    expect(await 背调计一次(owner, "run-c", "pages", 3)).toBe("ok");
    expect(await 背调计一次(别人, "run-c", "pages", 3)).toBe("没有");
    expect(await 背调计一次(owner, "run-c", "searches", 3, Date.now() + 背调有效期 + 1000)).toBe("过期");
  });

  it("并发十次只放行上限那么多", async () => {
    const { 按背调扣, 背调计一次 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    await 按背调扣(owner, "run-p", 6, true);
    const rs = await Promise.all(Array.from({ length: 10 }, () => 背调计一次(owner, "run-p", "searches", 4)));
    expect(rs.filter((r) => r === "ok").length).toBe(4);
  });
});
