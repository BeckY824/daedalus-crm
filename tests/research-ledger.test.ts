import { closeTestDatabases } from "./close-databases";
/**
 * AI 背调的账（lib/tenant/credits.ts 的 按背调扣 / 退背调 / 背调计一次 / 收尾背调，2026-10-16）。
 *
 * 钉的全是钱（10-16 用户定：背调单独计数，和问答的 AI 次数分开）：
 *   1. 一次背调扣 1 次**背调次数**，**问答的 AI 次数一次都不动**；背调次数不够就不扣
 *   2. 同一个 runId 重发 start 不重扣
 *   3. 背调里带同一个编号的模型调用不扣 AI 次数，步数放宽到 60——**只对背调放宽**
 *   4. 退是整笔退、只退一次；背调里某一步模型失败不按步退
 *   5. 测试账号不扣，但有那一行（搜索 / 读页认它）
 *   6. 背调次数从哪来：运营台手动加、RESEARCH_SIGNUP_GRANT（默认 0）
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
/** 建账号：问答送 30 次（和以前一样），背调另送 背调次（默认 3） */
async function 建账号(背调次 = 3) {
  const { control } = await import("@/lib/tenant/control");
  const id = `racc${序号++}`;
  await control.account.create({ data: { id, email: `${id}@t.test`, password: "x", name: id } });
  const 账本 = await import("@/lib/tenant/credits");
  await 账本.赠送({ kind: "account", id }, { amount: 30, reason: "signup", key: `${id}:signup` });
  if (背调次 > 0) await 账本.赠送背调(id, { amount: 背调次, reason: "admin" });
  return { kind: "account" as const, id };
}

async function 背调剩(owner: { kind: "account"; id: string }) {
  return (await (await import("@/lib/tenant/credits")).背调余额(owner)).还剩;
}

async function 用掉(owner: { kind: "account"; id: string }) {
  return (await import("@/lib/tenant/credits")).用掉次数(owner);
}

beforeEach(async () => {
  const { control } = await import("@/lib/tenant/control");
  await control.aiResearchRun.deleteMany({});
  await control.aiCharge.deleteMany({});
  await control.accountAiUsage.deleteMany({});
  await control.accountAiGrant.deleteMany({});
  await control.researchGrant.deleteMany({});
  delete process.env.RESEARCH_SIGNUP_GRANT;
  await control.testAccount.deleteMany({});
  await control.account.deleteMany({});
});

describe("开始一次背调：扣 1 次背调次数", () => {
  it("扣的是背调次数，问答的 AI 次数一次都不动", async () => {
    const { 按背调扣 } = await import("@/lib/tenant/credits");
    const owner = await 建账号(3);
    expect(await 按背调扣(owner, "run-a")).toEqual({ ok: true, 扣了: 1, 还剩: 2 });
    expect(await 按背调扣(owner, "run-b")).toEqual({ ok: true, 扣了: 1, 还剩: 1 });
    expect(await 背调剩(owner)).toBe(1);
    expect(await 用掉(owner)).toBe(0);
  });

  it("同一个 runId 重发不重扣", async () => {
    const { 按背调扣 } = await import("@/lib/tenant/credits");
    const owner = await 建账号(3);
    await 按背调扣(owner, "run-x");
    expect(await 按背调扣(owner, "run-x")).toEqual({ ok: true, 扣了: 0, 还剩: 2 });
    expect(await 背调剩(owner)).toBe(2);
  });

  it("背调次数用完了就不扣，也不留那一行；问答次数多少都不管用", async () => {
    const { 按背调扣 } = await import("@/lib/tenant/credits");
    const { control } = await import("@/lib/tenant/control");
    const owner = await 建账号(0);
    expect(await 按背调扣(owner, "run-poor")).toEqual({ ok: false, 还剩: 0 });
    expect(await control.aiResearchRun.count()).toBe(0);
    expect(await control.aiCharge.count()).toBe(0);
    expect(await 用掉(owner)).toBe(0);
  });

  it("新用户送几次背调按 RESEARCH_SIGNUP_GRANT（默认 0），一个账号只送一次", async () => {
    const { 背调余额 } = await import("@/lib/tenant/credits");
    const owner = await 建账号(0);
    expect((await 背调余额(owner)).还剩).toBe(0);
    process.env.RESEARCH_SIGNUP_GRANT = "2";
    expect((await 背调余额(owner)).还剩).toBe(2);
    expect((await 背调余额(owner)).还剩).toBe(2);
  });

  it("测试账号不扣，但有那一行（units = 0），搜索认得出", async () => {
    const { 按背调扣, 背调计一次, 设测试账号 } = { ...(await import("@/lib/tenant/credits")), ...(await import("@/lib/tenant/test-accounts")) };
    const { control } = await import("@/lib/tenant/control");
    const owner = await 建账号(0);
    await 设测试账号(owner.id, true, "测试");
    const r = await 按背调扣(owner, "run-t");
    expect(r.ok && r.扣了).toBe(0);
    const row = await control.aiResearchRun.findFirst({ where: { ownerId: owner.id, runId: "run-t" } });
    expect(row?.units).toBe(0);
    expect(await 背调计一次(owner, "run-t", "searches", 10)).toBe("ok");
  });
});

describe("背调里的模型调用", () => {
  it("带同一个编号的模型调用一次 AI 次数都不扣（背调的钱在背调次数里收了）", async () => {
    const { 按背调扣, 按问题扣一次 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    await 按背调扣(owner, "run-m");
    for (let i = 0; i < 30; i++) {
      const r = await 按问题扣一次(owner, "run-m");
      expect(r.ok && r.扣了, `第 ${i + 1} 步不该扣`).toBe(false);
    }
    expect(await 用掉(owner)).toBe(0);
  });

  it("背调放宽到 60 步，第 61 步才当新问题扣 1 次 AI", async () => {
    const { 按背调扣, 按问题扣一次, 背调最多步 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    await 按背调扣(owner, "run-long");
    for (let i = 0; i < 背调最多步; i++) await 按问题扣一次(owner, "run-long");
    expect(await 用掉(owner)).toBe(0);
    const 再来 = await 按问题扣一次(owner, "run-long");
    expect(再来.ok && 再来.扣了).toBe(true);
    expect(await 用掉(owner)).toBe(1);
  });

  it("**普通问题仍是 20 步**——放宽只认背调", async () => {
    const { 按问题扣一次, 每问最多步 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    for (let i = 0; i < 每问最多步; i++) await 按问题扣一次(owner, "q-plain");
    expect(await 用掉(owner)).toBe(1);
    expect((await 按问题扣一次(owner, "q-plain")).ok).toBe(true);
    expect(await 用掉(owner)).toBe(2);
  });

  it("退过的背调不再放宽：再拿这个编号调模型就是普通问题", async () => {
    const { 按背调扣, 按问题扣一次, 退背调, 每问最多步 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    await 按背调扣(owner, "run-r");
    await 退背调(owner, "run-r");
    for (let i = 0; i < 每问最多步; i++) await 按问题扣一次(owner, "run-r");
    expect(await 用掉(owner)).toBe(1);
    await 按问题扣一次(owner, "run-r");
    expect(await 用掉(owner)).toBe(2);
  });

  it("背调里某一步上游失败不按步退，也不动 AI 次数；整笔退只退背调那 1 次", async () => {
    const { 按背调扣, 按问题扣一次, 退这一次, 退背调 } = await import("@/lib/tenant/credits");
    const owner = await 建账号(3);
    await 按背调扣(owner, "run-f");
    await 按问题扣一次(owner, "run-f");
    await 退这一次(owner, "run-f", true);
    expect(await 用掉(owner)).toBe(0);
    const r = await 按问题扣一次(owner, "run-f");
    expect(r.ok && r.扣了).toBe(false);
    expect(await 退背调(owner, "run-f")).toBe(1);
    expect(await 背调剩(owner)).toBe(3);
  });
});

describe("退和收尾", () => {
  it("整笔退，只退一次；AiCharge 那行一起标成退过", async () => {
    const { 按背调扣, 退背调 } = await import("@/lib/tenant/credits");
    const { control } = await import("@/lib/tenant/control");
    const owner = await 建账号(3);
    await 按背调扣(owner, "run-q");
    expect(await 退背调(owner, "run-q")).toBe(1);
    expect(await 退背调(owner, "run-q")).toBe(0);
    expect(await 背调剩(owner)).toBe(3);
    const charge = await control.aiCharge.findFirst({ where: { ownerId: owner.id, requestId: "run-q" } });
    expect(charge?.refunded).toBe(true);
  });

  it("退过的 runId 再 start 是新的一笔，计数清零", async () => {
    const { 按背调扣, 退背调, 背调计一次 } = await import("@/lib/tenant/credits");
    const owner = await 建账号(3);
    await 按背调扣(owner, "run-again");
    await 背调计一次(owner, "run-again", "searches", 10);
    await 退背调(owner, "run-again");
    expect(await 背调计一次(owner, "run-again", "searches", 10)).toBe("退过");
    expect((await 按背调扣(owner, "run-again")).ok).toBe(true);
    expect(await 背调剩(owner)).toBe(2);
    const { control } = await import("@/lib/tenant/control");
    expect((await control.aiResearchRun.findFirst({ where: { runId: "run-again" } }))?.searches).toBe(0);
  });

  it("收尾 ok=false 退；先报出了报告、再补一句没出，不退", async () => {
    const { 按背调扣, 收尾背调 } = await import("@/lib/tenant/credits");
    const owner = await 建账号(3);
    await 按背调扣(owner, "run-bad");
    expect(await 收尾背调(owner, "run-bad", false)).toEqual({ 有这笔: true, 退了: 1 });
    expect(await 收尾背调(owner, "run-bad", false)).toEqual({ 有这笔: true, 退了: 0 });

    await 按背调扣(owner, "run-good");
    expect(await 收尾背调(owner, "run-good", true)).toEqual({ 有这笔: true, 退了: 0 });
    expect(await 收尾背调(owner, "run-good", false)).toEqual({ 有这笔: true, 退了: 0 });
    expect(await 背调剩(owner)).toBe(2);
    expect(await 收尾背调(owner, "nope", false)).toEqual({ 有这笔: false, 退了: 0 });
  });

  it("服务器已经交出过材料的，桌面端报「没出报告」也不退（被改过的客户端白拿搜索）", async () => {
    const { 按背调扣, 收尾背调, 背调有收获 } = await import("@/lib/tenant/credits");
    const owner = await 建账号(3);
    await 按背调扣(owner, "run-greedy");
    await 背调有收获(owner, "run-greedy");
    expect(await 收尾背调(owner, "run-greedy", false)).toEqual({ 有这笔: true, 退了: 0 });
    expect(await 背调剩(owner)).toBe(2);
  });
});

describe("该退背调（收尾时的判断，10-16 下午总控定）", () => {
  it("从上往下第一条命中的算", async () => {
    const { 该退背调 } = await import("@/lib/tenant/credits");
    const 基 = { hits: 3, failures: 0, reportAt: null as Date | null, ok: false, 取消: false };
    expect(该退背调({ ...基, reportAt: new Date(), failures: 2 })).toBe(false); // 最后一步交出去了
    expect(该退背调({ ...基, ok: true, failures: 2 })).toBe(false); // 桌面端自己说跑完了
    expect(该退背调({ ...基, hits: 0, 取消: true })).toBe(true); // 什么都没拿到
    expect(该退背调({ ...基, failures: 1, 取消: true })).toBe(false); // 用户自己停的
    expect(该退背调({ ...基, failures: 1 })).toBe(true); // 我们这边超时 / 报错没跑完
    expect(该退背调(基)).toBe(false); // 没证据
  });

  it("记失败 / 交报告落到库里；收尾按它们退", async () => {
    const { 按背调扣, 收尾背调, 背调有收获, 背调记失败, 背调交了报告 } = await import("@/lib/tenant/credits");
    const owner = await 建账号(3);
    await 按背调扣(owner, "run-timeout");
    await 背调有收获(owner, "run-timeout");
    await 背调记失败(owner, "run-timeout");
    expect(await 收尾背调(owner, "run-timeout", false)).toEqual({ 有这笔: true, 退了: 1 });

    await 按背调扣(owner, "run-finished");
    await 背调有收获(owner, "run-finished");
    await 背调记失败(owner, "run-finished");
    await 背调交了报告(owner, "run-finished");
    expect(await 收尾背调(owner, "run-finished", false)).toEqual({ 有这笔: true, 退了: 0 });
    expect(await 背调剩(owner)).toBe(2);
  });
});

describe("搜索 / 读页的次数闸", () => {
  it("到上限就不加了；别人的 runId 不认；过期的不认", async () => {
    const { 按背调扣, 背调计一次, 背调还一次, 背调有效期 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    const 别人 = await 建账号();
    await 按背调扣(owner, "run-c");
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
    await 按背调扣(owner, "run-p");
    const rs = await Promise.all(Array.from({ length: 10 }, () => 背调计一次(owner, "run-p", "searches", 4)));
    expect(rs.filter((r) => r === "ok").length).toBe(4);
  });
});
