/**
 * 试用期的 AI 免费次数。
 *
 * 和 lib/ai-quota.ts 是两回事，混了就都不对：
 *   ai-quota   五分钟 30 次、内存态、重启清零 —— 防脚本刷爆，人正常用碰不到
 *   这里       试用期一共 5 次、落库、永不重置 —— 这是定价的一部分
 *
 * 最要紧的是并发那条：两个标签页同时提问，先读再写会让 5 次额度被用掉 6 次。
 * 每多放行一次就是一次真金白银的上游调用。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-allow-${process.pid}`);

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  process.env.MULTI_TENANT = "1";
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时根, "control.db")}`;
  const sql = execFileSync(
    "npx",
    ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"],
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

afterAll(() => {
  delete process.env.MULTI_TENANT;
  fs.rmSync(临时根, { recursive: true, force: true });
});

const 天 = 86_400_000;
let 序号 = 0;

async function 建工作区(opts: { 付费?: boolean; 过期?: boolean; 停用?: boolean } = {}) {
  const { control } = await import("@/lib/tenant/control");
  const id = `ws${序号++}`;
  await control.workspace.create({
    data: {
      id, slug: id, name: id, dbFile: `${id}.db`,
      status: opts.停用 ? "SUSPENDED" : opts.付费 ? "ACTIVE" : "TRIAL",
      trialEndsAt: new Date(Date.now() + (opts.过期 ? -天 : 3 * 天)),
      paidUntil: opts.付费 ? new Date(Date.now() + 300 * 天) : null,
    },
  });
  return id;
}

beforeEach(async () => {
  const { control } = await import("@/lib/tenant/control");
  await control.aiUsage.deleteMany({});
});

describe("试用工作区", () => {
  it("前 5 次放行，第 6 次拦下", async () => {
    const { 扣一次额度, 试用对话上限 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区();
    for (let i = 1; i <= 试用对话上限; i++) {
      const r = await 扣一次额度(ws);
      expect(r.ok, `第 ${i} 次该放行`).toBe(true);
      if (r.ok) expect(r.还剩).toBe(试用对话上限 - i);
    }
    const 第六次 = await 扣一次额度(ws);
    expect(第六次.ok).toBe(false);
    if (!第六次.ok) expect(第六次.error).toContain("开通订阅");
  });

  it("并发提问不会多放行——先读再写会让 5 次被用掉 6 次", async () => {
    const { 扣一次额度, 试用对话上限 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区();
    const 结果 = await Promise.all(Array.from({ length: 12 }, () => 扣一次额度(ws)));
    expect(结果.filter((r) => r.ok).length).toBe(试用对话上限);
  });

  it("拦下之后计数不会顶着上限往上飘给人看", async () => {
    const { 扣一次额度, 查额度, 试用对话上限 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区();
    for (let i = 0; i < 20; i++) await 扣一次额度(ws);
    const q = await 查额度(ws);
    expect(q.用掉).toBe(试用对话上限);
    expect(q.还剩).toBe(0);
  });

  it("额度按工作区算，不按人头——否则拉五个同事进来就有 25 次", async () => {
    const { 扣一次额度, 试用对话上限 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区();
    // 同一个工作区里不管谁问，扣的都是同一个池子（函数签名里根本没有 userId）
    for (let i = 0; i < 试用对话上限; i++) await 扣一次额度(ws);
    expect((await 扣一次额度(ws)).ok).toBe(false);
  });

  it("试用到期后连第一次都不给——那是花钱的动作", async () => {
    const { 扣一次额度 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区({ 过期: true });
    const r = await 扣一次额度(ws);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("试用已结束");
  });

  it("被停用的工作区同样不给", async () => {
    const { 扣一次额度 } = await import("@/lib/tenant/ai-allowance");
    expect((await 扣一次额度(await 建工作区({ 停用: true }))).ok).toBe(false);
  });
});

describe("付费工作区", () => {
  it("不限次数，也不计数——付了钱还数次数就成了另一种产品", async () => {
    const { 扣一次额度, 查额度 } = await import("@/lib/tenant/ai-allowance");
    const { control } = await import("@/lib/tenant/control");
    const ws = await 建工作区({ 付费: true });
    for (let i = 0; i < 30; i++) {
      expect((await 扣一次额度(ws)).ok).toBe(true);
    }
    expect(await control.aiUsage.findUnique({ where: { workspaceId: ws } })).toBeNull();
    expect((await 查额度(ws)).受限).toBe(false);
  });

  it("试用期间用完了，开通订阅之后立刻恢复", async () => {
    const { 扣一次额度, 试用对话上限 } = await import("@/lib/tenant/ai-allowance");
    const { control } = await import("@/lib/tenant/control");
    const ws = await 建工作区();
    for (let i = 0; i < 试用对话上限 + 2; i++) await 扣一次额度(ws);
    expect((await 扣一次额度(ws)).ok).toBe(false);

    await control.workspace.update({ where: { id: ws }, data: { status: "ACTIVE", paidUntil: new Date(Date.now() + 300 * 天) } });
    // 不需要清计数：付费分支根本不看它
    expect((await 扣一次额度(ws)).ok).toBe(true);
  });
});

describe("运营台重置", () => {
  it("重置之后又有 5 次——谈单时想让对方多试几次", async () => {
    const { 扣一次额度, 重置额度, 试用对话上限 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区();
    for (let i = 0; i < 试用对话上限; i++) await 扣一次额度(ws);
    expect((await 扣一次额度(ws)).ok).toBe(false);

    await 重置额度(ws);
    expect((await 扣一次额度(ws)).ok).toBe(true);
  });
});

describe("自部署版", () => {
  it("没开 MULTI_TENANT 时闸门直接放行，一次都不限", async () => {
    const { 试用额度闸门 } = await import("@/lib/tenant/ai-allowance");
    delete process.env.MULTI_TENANT;
    for (let i = 0; i < 20; i++) expect(await 试用额度闸门()).toBeNull();
    process.env.MULTI_TENANT = "1";
  });
});
